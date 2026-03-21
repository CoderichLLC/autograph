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
  emit(event, data) {
    // Here we pull out functions with "next" vs those without
    const [basicFuncs, nextFuncs] = this.rawListeners(event).reduce((prev, wrapper) => {
      const { listener = wrapper } = wrapper;
      const isBasic = listener.length < 2;
      wrapper.priority = listener.priority ?? 0;
      return prev[isBasic ? 0 : 1].push(wrapper) && prev;
    }, [[], []]);

    // // Basic functions are not designed to be bound to the query execution so we need an isolated resolver from any transactions
    // const resolver = data?.resolver?.clone();
    // const basicData = { ...data, resolver };

    return new Promise((resolve, reject) => {
      // Basic functions run first; if they return a value they abort the flow of execution
      basicFuncs.sort(Emitter.sort).forEach((fn) => {
        const value = fn(data);
        if (value !== undefined && !(value instanceof Promise)) throw new AbortEarlyError(value);
      });

      // Next functions are async and control the timing of the next phase
      Promise.all(nextFuncs.sort(Emitter.sort).map((fn) => {
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
    return super.on(event, listener);
  }

  prependListener(event, listener, priority = 0) {
    listener.priority = priority;
    return super.prependListener(event, listener);
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
