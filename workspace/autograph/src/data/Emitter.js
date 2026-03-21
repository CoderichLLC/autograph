const EventEmitter = require('node:events');
const Util = require('@coderich/util');
const { AbortEarlyError } = require('../service/ErrorService');

/**
 * EventEmitter.
 *
 * The difference is that I'm looking at each raw listeners to determine how many arguments it's expecting.
 * If it expects more than 1 we block and wait for it to finish.
 */
class Emitter extends EventEmitter {
  #cache = new Map();

  #invalidate(event) {
    this.#cache.delete(event);
  }

  #getListeners(event) {
    if (!this.#cache.has(event)) {
      const [basicFuncs, nextFuncs] = this.rawListeners(event).reduce((prev, wrapper) => {
        const { listener = wrapper } = wrapper;
        wrapper.priority = listener.priority ?? 0;
        return prev[listener.length < 2 ? 0 : 1].push(wrapper) && prev;
      }, [[], []]);
      this.#cache.set(event, { basicFuncs: basicFuncs.sort(Emitter.sort), nextFuncs: nextFuncs.sort(Emitter.sort) });
    }
    return this.#cache.get(event);
  }

  emit(event, data) {
    const { basicFuncs, nextFuncs } = this.#getListeners(event);

    return new Promise((resolve, reject) => {
      // Basic functions run first; if they return a value they abort the flow of execution
      basicFuncs.forEach((fn) => {
        const value = fn(data);
        if (value !== undefined && !(value instanceof Promise)) throw new AbortEarlyError(value);
      });

      // Next functions are async and control the timing of the next phase
      Promise.all(nextFuncs.map((fn) => {
        return new Promise((next, err) => {
          Promise.resolve().then(() => fn(data, next)).catch(err);
        }).then((result) => {
          if (result !== undefined) throw new AbortEarlyError(result);
        }).catch(reject);
      })).then(() => resolve()); // Resolve to undefined
    }).catch((e) => {
      if (e instanceof AbortEarlyError) return e.data;
      throw e;
    });
  }

  on(event, listener, priority = 0) {
    listener.priority = priority;
    this.#invalidate(event);
    return super.on(event, listener);
  }

  addListener(event, listener, priority = 0) {
    return this.on(event, listener, priority);
  }

  once(event, listener, priority = 0) {
    listener.priority = priority;
    this.#invalidate(event);
    return super.once(event, listener);
  }

  prependListener(event, listener, priority = 0) {
    listener.priority = priority;
    this.#invalidate(event);
    return super.prependListener(event, listener);
  }

  prependOnceListener(event, listener, priority = 0) {
    listener.priority = priority;
    this.#invalidate(event);
    return super.prependOnceListener(event, listener);
  }

  removeListener(event, listener) {
    this.#invalidate(event);
    return super.removeListener(event, listener);
  }

  off(event, listener) {
    return this.removeListener(event, listener);
  }

  removeAllListeners(event) {
    if (event) this.#invalidate(event);
    else this.#cache.clear();
    return super.removeAllListeners(event);
  }

  /**
   * Syntactic sugar to listen on query keys
   */
  onKeys(...args) {
    return this.#createWrapper('key', false, ...args,);
  }

  /**
   * Syntactic sugar to listen once on query keys
   */
  onceKeys(...args) {
    return this.#createWrapper('key', true, ...args);
  }

  /**
   * Syntactic sugar to listen on query models
   */
  onModels(...args) {
    return this.#createWrapper('model', false, ...args);
  }

  /**
   * Syntactic sugar to listen once on query models
   */
  onceModels(...args) {
    return this.#createWrapper('model', true, ...args);
  }

  #createWrapper(prop, once, eventName, arr, listener, priority) {
    arr = Util.ensureArray(arr);

    const wrapper = listener.length < 2 ? (event) => {
      if (arr.includes(`${event.query[prop]}`)) {
        if (once) this.removeListener(eventName, wrapper);
        return listener(event);
      }
      return undefined;
    } : (event, next) => {
      if (arr.includes(`${event.query[prop]}`)) {
        if (once) this.removeListener(eventName, wrapper);
        return listener(event, next);
      }
      return next();
    };

    return this.on(eventName, wrapper, priority);
  }

  static sort(a, b) {
    if (a.priority > b.priority) return -1;
    if (a.priority < b.priority) return 1;
    return 0;
  }
}

module.exports = new Emitter().setMaxListeners(100);
