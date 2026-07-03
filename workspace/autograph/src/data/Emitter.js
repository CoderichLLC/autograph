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

// Registration-time prep: stamp the listener's ROLE and priority, and swap in a memoizing
// wrapper when opted in. Priority/role are set on both the wrapper and the original listener so
// `#getListeners` can read them through either side of the (potential) once-wrap that
// EventEmitter adds internally.
const prepareListener = (listener, opts, role) => {
  const priority = opts.priority ?? 0;
  let target = listener;
  // Observers are always invoked in the (event)-only form, so they always take the basic-shaped
  // memoize wrapper regardless of declared arity.
  if (opts.memoize) target = (role === 'observer' || listener.length < 2) ? wrapBasicMemoize(listener) : wrapNextMemoize(listener);
  target.priority = priority;
  target.$role = role;
  if (target !== listener) {
    listener.priority = priority;
    listener.$role = role;
  }
  return target;
};

/**
 * EventEmitter with two explicit listener roles, declared at REGISTRATION (never inferred from
 * a function's arity — parameter count is a call-convention detail, not a semantic contract):
 *
 *   PARTICIPANTS — `on()` / `once()` / `onModels()` / `onKeys()` / ... The event awaits them.
 *     They receive the ambient `event.resolver` (transaction participants — their writes share
 *     the unit's fate), their throw/rejection is the event's failure (aborts a carried unit —
 *     see Resolver#createSystemEvent), and a non-undefined return value (sync or resolved)
 *     SHORT-CIRCUITS the event with that value. Plain functions — sync or async; the legacy
 *     AG15 done-callback form `(event, next)` is still honored by arity as a CALL CONVENTION
 *     only (next(value) === return value).
 *
 *   OBSERVERS — `observe()` / `observeModels()` / `observeKeys()`. Fire-and-forget on every
 *     event: never awaited, failures deterministically isolated (sync throws swallowed, async
 *     rejections attached to a no-op handler — never an unhandled rejection), return values
 *     ignored (an un-awaited value can never shape an awaited outcome), and they receive the
 *     DETACHED resolver (no transaction scope, ever — reads see committed state, writes land
 *     immediately and survive any ambient rollback; see Resolver#detach and TRANSACTIONS.md
 *     §4.18). Un-awaitable code cannot be a transaction participant — the role makes that
 *     safe by construction instead of by discipline.
 *
 * Dispatch: observers first (priority order), then participants initiated synchronously in one
 * flat priority order. A participant's SYNC non-undefined return short-circuits immediately —
 * later participants never initiate (the cheap-veto power). Async participants run concurrently;
 * the first resolved non-undefined value wins the short-circuit race (as before).
 *
 * Memoization is handled at registration time (see `prepareListener`) — `emit()` itself has
 * zero memo-aware branching. The hot loop stays a tight dispatch.
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
      const observers = [];
      const participants = [];
      this.rawListeners(event).forEach((wrapper) => {
        const { listener = wrapper } = wrapper;
        wrapper.priority = listener.priority ?? wrapper.priority ?? 0;
        // Call-convention flag (legacy AG15 done-callback form), NOT a semantic role.
        wrapper.$useNext = listener.length >= 2;
        if ((listener.$role ?? wrapper.$role) === 'observer') observers.push(wrapper);
        else participants.push(wrapper);
      });
      this.#cache.set(event, { observers: observers.sort(Emitter.sort), participants: participants.sort(Emitter.sort) });
    }
    return this.#cache.get(event);
  }

  emit(event, data) {
    const { observers, participants } = this.#getListeners(event);

    // No listeners → no work. Skip the Promise allocation and empty loops entirely.
    if (observers.length === 0 && participants.length === 0) return Promise.resolve();

    // OBSERVERS first (priority order) — fire-and-forget, never awaited, never short-circuit,
    // failures deterministically isolated (a discarded rejected promise would be an unhandled
    // rejection — fatal on modern Node — so it gets a no-op handler; a sync throw is swallowed
    // the same way, deterministically, never raced into the event's own outcome). They receive
    // the DETACHED resolver (see Resolver#detach): un-awaitable code can never be a transaction
    // participant, so participant-grade session access would make its writes race the carrying
    // transaction's settle for membership. Everything else on the event (query, context, ...)
    // is shared by reference with the participants' event.
    if (observers.length) {
      const observerData = data?.resolver?.detach ? { ...data, resolver: data.resolver.detach() } : data;
      observers.forEach((fn) => {
        try {
          const value = fn(observerData);
          if (value instanceof Promise) value.catch(() => {});
        } catch { /* isolated by role — an observer's failure can never be the event's failure */ }
      });
    }

    if (participants.length === 0) return Promise.resolve();

    // PARTICIPANTS — initiated synchronously in one flat priority order. A SYNC non-undefined
    // return short-circuits immediately (later participants never initiate — the cheap veto);
    // a sync throw from a plain participant likewise aborts initiation (fail fast). Async
    // participants (and legacy done-callback ones, whose sync throws are captured as their own
    // rejection) run concurrently; the first RESOLVED non-undefined value wins the
    // short-circuit race, and any rejection is the event's failure.
    return new Promise((resolve, reject) => {
      const pending = [];
      participants.forEach((fn) => {
        if (fn.$useNext) {
          // Legacy AG15 call convention: (event, next) — next(value) === return value. An async
          // listener's rejection lands on its RETURNED promise (it never calls next), so that
          // promise must be chained into err or the pending promise would hang forever.
          pending.push(new Promise((next, err) => {
            try {
              const r = fn(data, next);
              if (r instanceof Promise) r.catch(err);
            } catch (e) { err(e); }
          }));
        } else {
          const value = fn(data);
          if (value instanceof Promise) pending.push(value);
          else if (value !== undefined) throw new AbortEarlyError(value);
        }
      });
      Promise.all(pending.map(p => p.then((result) => {
        if (result !== undefined) throw new AbortEarlyError(result);
      }))).then(() => resolve(), reject);
    }).catch((e) => {
      if (e instanceof AbortEarlyError) return e.data;
      throw e;
    });
  }

  on(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options), 'participant');
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.on(event, target);
  }

  addListener(event, listener, options) {
    return this.on(event, listener, options);
  }

  once(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options), 'participant');
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.once(event, target);
  }

  prependListener(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options), 'participant');
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.prependListener(event, target);
  }

  prependOnceListener(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options), 'participant');
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.prependOnceListener(event, target);
  }

  /**
   * Register an OBSERVER: fire-and-forget on every matching event — never awaited, failures
   * isolated, return value ignored, detached resolver in `event.resolver`. Use for telemetry,
   * audit, logging, and any side effect that must not share (or threaten) the mutation's fate.
   */
  observe(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options), 'observer');
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.on(event, target);
  }

  observeOnce(event, listener, options) {
    const target = prepareListener(listener, normalizeOptions(options), 'observer');
    this.#incGeneric(event);
    this.#invalidate(event);
    return super.once(event, target);
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
    return this.#createWrapper('key', false, 'participant', ...args);
  }

  /**
   * Syntactic sugar to listen once on query keys
   */
  onceKeys(...args) {
    return this.#createWrapper('key', true, 'participant', ...args);
  }

  /**
   * Syntactic sugar to listen on query models
   */
  onModels(...args) {
    return this.#createWrapper('model', false, 'participant', ...args);
  }

  /**
   * Syntactic sugar to listen once on query models
   */
  onceModels(...args) {
    return this.#createWrapper('model', true, 'participant', ...args);
  }

  /**
   * Observer-role variants of onKeys/onModels (see observe()).
   */
  observeKeys(...args) {
    return this.#createWrapper('key', false, 'observer', ...args);
  }

  observeModels(...args) {
    return this.#createWrapper('model', false, 'observer', ...args);
  }

  #createWrapper(prop, once, role, eventName, arr, listener, options) {
    arr = Util.ensureArray(arr);

    // Observers are always invoked (event)-only; participants keep their declared call
    // convention (plain vs legacy done-callback) — the wrapper must mirror it so the emit
    // dispatch reads the right convention off the wrapper's own arity.
    const wrapper = (role === 'observer' || listener.length < 2) ? (event) => {
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
    const target = prepareListener(wrapper, normalizeOptions(options), role);
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
