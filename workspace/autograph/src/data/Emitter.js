const EventEmitter = require('node:events');
const Util = require('@coderich/util');
const Query = require('../query/Query');
const { AbortEarlyError } = require('../service/ErrorService');

// Per-resolver memoization cache. WeakMap → entries vanish when the resolver
// (typically one per request) is garbage collected, so memo lifetime tracks
// request lifetime without any explicit teardown.
const memoCacheByResolver = new WeakMap();

const getResolverMemo = (resolver) => {
  let cache = memoCacheByResolver.get(resolver);
  if (!cache) {
    cache = new Map();
    memoCacheByResolver.set(resolver, cache);
  }
  return cache;
};

// Memo key for an event. The Resolver attaches the Query instance as `event.$query` in
// #createSystemEvent; we call `toCacheKey()` directly on it (per-instance lazy cache).
// Falls back to Query.computeCacheKey for direct/test emits that don't carry a Query
// instance. Returns null for events with no query at all (e.g., `setup`).
const getMemoKey = (data) => {
  if (data?.$query) return data.$query.toCacheKey();
  if (data?.query) return Query.computeCacheKey(data.query);
  return null;
};

// Wrap a basic-style listener (arity < 2) so its return value is cached per (resolver, query).
// On cache hit the listener is skipped entirely and the cached value is returned. The wrapper
// carries `.listener = listener` so `super.removeListener(event, originalFn)` still works
// (Node's EventEmitter matches by both reference and `.listener`).
const wrapBasicMemoize = (listener) => {
  const wrapper = (data) => {
    const resolver = data?.resolver;
    const key = resolver ? getMemoKey(data) : null;
    if (!resolver || key == null) return listener(data);
    const cache = getResolverMemo(resolver);
    let fnCache = cache.get(wrapper);
    if (fnCache?.has(key)) return fnCache.get(key);
    const value = listener(data);
    if (!fnCache) { fnCache = new Map(); cache.set(wrapper, fnCache); }
    fnCache.set(key, value);
    return value;
  };
  wrapper.listener = listener;
  return wrapper;
};

// Wrap a next-style listener (arity >= 2) so the value it passes to next() is cached per
// (resolver, query). On cache hit the wrapper calls next(cachedValue) directly and the
// listener never runs.
const wrapNextMemoize = (listener) => {
  const wrapper = (data, next) => {
    const resolver = data?.resolver;
    const key = resolver ? getMemoKey(data) : null;
    if (!resolver || key == null) {
      listener(data, next);
      return;
    }
    const cache = getResolverMemo(resolver);
    const fnCache = cache.get(wrapper);
    if (fnCache?.has(key)) {
      next(fnCache.get(key));
      return;
    }
    listener(data, (value) => {
      let fc = cache.get(wrapper);
      if (!fc) { fc = new Map(); cache.set(wrapper, fc); }
      fc.set(key, value);
      next(value);
    });
  };
  wrapper.listener = listener;
  return wrapper;
};

const normalizeOptions = (options) => {
  if (options == null) return {};
  if (typeof options !== 'object') throw new TypeError('Emitter listener options must be an object');
  return options;
};

// Registration-time prep: swap the listener for a memoizing wrapper when opted in.
// Priority is set on both the wrapper and the original listener so `#getListeners` can read
// it through either side of the (potential) once-wrap that EventEmitter adds internally.
const prepareListener = (listener, opts) => {
  const priority = opts.priority ?? 0;
  const target = opts.memoize
    ? (listener.length < 2 ? wrapBasicMemoize(listener) : wrapNextMemoize(listener))
    : listener;
  target.priority = priority;
  if (target !== listener) listener.priority = priority;
  return target;
};

/**
 * EventEmitter.
 *
 * The difference is that I'm looking at each raw listeners to determine how many arguments it's expecting.
 * If it expects more than 1 we block and wait for it to finish.
 *
 * Memoization is handled at registration time (see `prepareListener`) — `emit()` itself has
 * zero memo-aware branching. Listeners that opt in to `{ memoize: true }` are swapped for a
 * memoizing wrapper of the right arity; everything else is registered as-is. The hot loop
 * stays a tight dispatch.
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
        wrapper.priority = listener.priority ?? wrapper.priority ?? 0;
        return prev[listener.length < 2 ? 0 : 1].push(wrapper) && prev;
      }, [[], []]);
      this.#cache.set(event, { basicFuncs: basicFuncs.sort(Emitter.sort), nextFuncs: nextFuncs.sort(Emitter.sort) });
    }
    return this.#cache.get(event);
  }

  emit(event, data) {
    const { basicFuncs, nextFuncs } = this.#getListeners(event);

    // No listeners → no work. Skip the Promise allocation and empty loops entirely.
    if (basicFuncs.length === 0 && nextFuncs.length === 0) return Promise.resolve();

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

  on(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options));
    this.#invalidate(event);
    return super.on(event, target);
  }

  addListener(event, listener, options) {
    return this.on(event, listener, options);
  }

  once(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options));
    this.#invalidate(event);
    return super.once(event, target);
  }

  prependListener(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options));
    this.#invalidate(event);
    return super.prependListener(event, target);
  }

  prependOnceListener(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options));
    this.#invalidate(event);
    return super.prependOnceListener(event, target);
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
    return this.#createWrapper('key', false, ...args);
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

  #createWrapper(prop, once, eventName, arr, listener, options) {
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

    return this.on(eventName, wrapper, options);
  }

  static sort(a, b) {
    if (a.priority > b.priority) return -1;
    if (a.priority < b.priority) return 1;
    return 0;
  }
}

module.exports = new Emitter().setMaxListeners(100);
