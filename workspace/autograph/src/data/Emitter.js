const EventEmitter = require('node:events');
const Util = require('@coderich/util');
const Query = require('../query/Query');
const { AbortEarlyError } = require('../service/ErrorService');
const { $QUERY } = require('../service/Symbols');

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

// Memo key for an event. The Resolver attaches the Query instance under a Symbol-keyed slot
// on the event object (see Symbols.$QUERY); the Symbol key keeps it invisible to spread,
// JSON.stringify, and for-in while letting V8 keep the event object's hidden class stable
// (no later defineProperty). Calling `toCacheKey()` is cheap (per-instance lazy cache).
// Falls back to Query.computeCacheKey for direct/test emits that don't carry a Query
// instance. Returns null for events with no query at all (e.g., `setup`).
const getMemoKey = (data) => {
  const q = data?.[$QUERY];
  if (q) return q.toCacheKey();
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
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`Emitter listener options must be an object (received ${typeof options}); did you mean { priority: <n>, memoize: <bool> }?`);
  }
  return options;
};

// Registration-time prep: swap the listener for a memoizing wrapper when opted in.
// Priority is set on both the wrapper and the original listener so `#getListeners` can read
// it through either side of the (potential) once-wrap that EventEmitter adds internally.
const prepareListener = (listener, opts) => {
  const priority = opts.priority ?? 0;
  let target = listener;
  if (opts.memoize) target = listener.length < 2 ? wrapBasicMemoize(listener) : wrapNextMemoize(listener);
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

  // Per-event listener index for the model-aware fast path.
  //   genericCount — listeners registered without a model/key filter (Emitter.on/once direct).
  //   byModel/byKey — wrapper listeners registered via onModels/onKeys, keyed by their filter value.
  // hasListenersFor(event, model, key) answers "would any listener body actually run for this
  // event+model+key combination?" without invoking the wrappers themselves. Resolver uses this
  // to skip the entire emit chain for queries with no relevant hooks.
  #listenerIndex = new Map(); // event → { genericCount, byModel: Map<string, count>, byKey: Map<string, count> }
  #wrapperFilter = new WeakMap(); // registered listener (after prepareListener wrap) → { prop, arr } for decrement on remove

  #invalidate(event) {
    this.#cache.delete(event);
  }

  #getIndex(event) {
    let entry = this.#listenerIndex.get(event);
    if (!entry) {
      entry = { genericCount: 0, byModel: new Map(), byKey: new Map() };
      this.#listenerIndex.set(event, entry);
    }
    return entry;
  }

  #incFilter(event, prop, arr) {
    const entry = this.#getIndex(event);
    const map = prop === 'model' ? entry.byModel : entry.byKey;
    for (const v of arr) {
      const k = `${v}`;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
  }

  #decFilter(event, prop, arr) {
    const entry = this.#listenerIndex.get(event);
    if (!entry) return;
    const map = prop === 'model' ? entry.byModel : entry.byKey;
    for (const v of arr) {
      const k = `${v}`;
      const c = (map.get(k) ?? 0) - 1;
      if (c <= 0) map.delete(k); else map.set(k, c);
    }
  }

  #incGeneric(event) {
    this.#getIndex(event).genericCount += 1;
  }

  #decGeneric(event) {
    const entry = this.#listenerIndex.get(event);
    if (entry) entry.genericCount = Math.max(0, entry.genericCount - 1);
  }

  /**
   * Returns true iff any registered listener's filter (or lack thereof) would match an event
   * with the given model/key. Resolver's #createSystemEvent uses this as the fast-path guard.
   */
  hasListenersFor(event, model, key) {
    const entry = this.#listenerIndex.get(event);
    if (!entry) return false;
    if (entry.genericCount > 0) return true;
    if (model != null && entry.byModel.get(`${model}`) > 0) return true;
    if (key != null && entry.byKey.get(`${key}`) > 0) return true;
    return false;
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
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.on(event, target);
  }

  addListener(event, listener, options) {
    return this.on(event, listener, options);
  }

  once(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options));
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.once(event, target);
  }

  prependListener(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options));
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.prependListener(event, target);
  }

  prependOnceListener(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options));
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.prependOnceListener(event, target);
  }

  removeListener(event, listener) {
    // Find the matching registered listener (might be a memoize wrapper around the original).
    // Node's EventEmitter resolves both direct-reference and .listener-equality matches.
    const raw = this.rawListeners(event).find(l => l === listener || l.listener === listener);
    if (raw) {
      const filter = this.#wrapperFilter.get(raw);
      if (filter) {
        this.#decFilter(event, filter.prop, filter.arr);
        this.#wrapperFilter.delete(raw);
      } else {
        this.#decGeneric(event);
      }
    }
    this.#invalidate(event);
    return super.removeListener(event, listener);
  }

  off(event, listener) {
    return this.removeListener(event, listener);
  }

  removeAllListeners(event) {
    if (event) {
      // Decrement counts for every registered listener on this event before clearing.
      for (const raw of this.rawListeners(event)) {
        const filter = this.#wrapperFilter.get(raw);
        if (filter) {
          this.#decFilter(event, filter.prop, filter.arr);
          this.#wrapperFilter.delete(raw);
        } else {
          this.#decGeneric(event);
        }
      }
      this.#invalidate(event);
    } else {
      this.#listenerIndex.clear();
      this.#cache.clear();
    }
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
    // Without this, Emitter.removeListener(event, originalFn) can never find this wrapper —
    // it's neither reference-equal to `listener` nor (absent this line) linked back to it via
    // `.listener`, the same convention wrapBasicMemoize/wrapNextMemoize already rely on (see
    // removeListener's `l === listener || l.listener === listener` match) — so a hook registered
    // via onModels/onKeys/onceModels/onceKeys could never actually be removed again.
    wrapper.listener = listener;

    // Register via super.on directly (not this.on) so we can record the filter info in the
    // per-(event, model|key) index instead of bumping the generic count. The model-aware
    // listener fast path in #createSystemEvent depends on this distinction. Note: always
    // super.on regardless of `once` — the wrapper itself self-removes on a matching emit,
    // which preserves the "only fires once on a MATCHING event" semantic. Using super.once
    // would let Node auto-remove on the first emit even when the model didn't match.
    const target = prepareListener(wrapper, normalizeOptions(options));
    this.#wrapperFilter.set(target, { prop, arr });
    this.#incFilter(eventName, prop, arr);
    this.#invalidate(eventName);
    return super.on(eventName, target);
  }

  static sort(a, b) {
    if (a.priority > b.priority) return -1;
    if (a.priority < b.priority) return 1;
    return 0;
  }
}

module.exports = new Emitter().setMaxListeners(100);
