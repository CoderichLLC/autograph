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

// ---- 0.16 filter-object registration (see docs/superpowers/specs/2026-07-03-emitter-filter-api-design.md) ----
// Normalization/validation is registration-time (cold path) and LOUD — same doctrine as the
// where Vocabulary allowlist: a typo'd filter must never become a silent match-all (or match-
// nothing) listener.
const FILTER_KEYS = ['event', 'model', 'crud', 'priority', 'once', 'memoize'];
const CRUD_WORDS = ['create', 'read', 'update', 'delete'];
const CRUD_FLAGS = { c: 'create', r: 'read', u: 'update', d: 'delete' };

const normalizeFilter = (filter) => {
  if (typeof filter === 'string') filter = { event: filter }; // shorthand: on('setup', fn)
  if (!Util.isPlainObject(filter)) throw new TypeError(`Emitter filter must be an event name or filter object (received ${typeof filter})`);
  const unknown = Object.keys(filter).filter(k => !FILTER_KEYS.includes(k));
  if (unknown.length) throw new TypeError(`Unknown Emitter filter key(s): ${unknown.join(', ')} — allowed: ${FILTER_KEYS.join(', ')}`);
  const events = Util.ensureArray(filter.event ?? []).map(String);
  if (!events.length) throw new TypeError('Emitter filter requires at least one event');
  const models = filter.model == null ? null : Util.ensureArray(filter.model).map(String);
  if (models && !models.length) throw new TypeError('Emitter filter "model" requires at least one value');
  let cruds = null;
  if (filter.crud != null) {
    // Word array, single word, or a flag string of c|r|u|d characters — all normalize to words.
    let parts;
    if (Array.isArray(filter.crud)) parts = filter.crud;
    else if (CRUD_WORDS.includes(filter.crud)) parts = [filter.crud];
    else parts = `${filter.crud}`.split('');
    cruds = parts.map((part) => {
      const word = CRUD_WORDS.includes(part) ? part : CRUD_FLAGS[part];
      if (!word) throw new TypeError(`Unknown crud filter "${part}" — allowed: flag string of [${Object.keys(CRUD_FLAGS).join('')}] or words [${CRUD_WORDS.join(', ')}]`);
      return word;
    });
  }
  if (cruds && !cruds.length) throw new TypeError('Emitter filter "crud" requires at least one value');
  return { events, models, cruds, opts: { priority: filter.priority, memoize: filter.memoize }, once: Boolean(filter.once) };
};

/**
 * EventEmitter with two explicit listener roles, declared at REGISTRATION (never inferred from
 * a function's arity — parameter count is a call-convention detail, not a semantic contract):
 *
 *   PARTICIPANTS — `on(filter, fn)`. The event awaits them. They receive the ambient
 *     `event.resolver` (transaction participants — their writes share the unit's fate), their
 *     throw/rejection is the event's failure (aborts a carried unit — see
 *     Resolver#createSystemEvent), and a non-undefined return value (sync or resolved)
 *     SHORT-CIRCUITS the event with that value. Plain functions — sync or async; the legacy
 *     AG15 done-callback form `(event, next)` is still honored by arity as a CALL CONVENTION
 *     only (next(value) === return value).
 *
 *   OBSERVERS — `observe(filter, fn)`. Fire-and-forget on every event: never awaited, failures
 *     deterministically isolated (sync throws swallowed, async rejections attached to a no-op
 *     handler — never an unhandled rejection), return values ignored (an un-awaited value can
 *     never shape an awaited outcome), and they receive the DETACHED resolver (no transaction
 *     scope, ever — reads see committed state, writes land immediately and survive any ambient
 *     rollback; see Resolver#detach and TRANSACTIONS.md §4.18). Un-awaitable code cannot be a
 *     transaction participant — the role makes that safe by construction instead of by
 *     discipline.
 *
 * `filter` is an event name (shorthand for `{ event: name }`) or a
 * `{ event, model, crud, priority, once, memoize }` bag — `event` is required (scalar or array),
 * everything else optional; dimensions AND together, values within a dimension OR (see
 * `normalizeFilter`). Both `on()` and `observe()` return a `dispose()` function that atomically
 * unregisters the whole registration (every event it fanned out to); calling it twice is a no-op.
 * `once`, `addListener`, `prependListener`, `prependOnceListener`, `onModels`, `onceModels`,
 * `onKeys`, `onceKeys`, `observeOnce`, `observeModels`, `observeKeys` were removed in 0.16 — the
 * methods still exist but throw with migration guidance (see the poisoned stubs below); letting
 * the base `EventEmitter` silently resurface them would produce listeners with no role stamping
 * and no index bookkeeping.
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

  #invalidate(event) {
    this.#cache.delete(event);
  }

  #listenerIndex = new Map(); // event → { genericCount, byModel: Map<model, count> }
  #wrapperFilter = new WeakMap(); // registered target → models array, for decrement on remove

  #getIndex(event) {
    let entry = this.#listenerIndex.get(event);
    if (!entry) {
      entry = { genericCount: 0, byModel: new Map() };
      this.#listenerIndex.set(event, entry);
    }
    return entry;
  }

  #incFilter(event, models) {
    const { byModel } = this.#getIndex(event);
    for (const m of models) byModel.set(m, (byModel.get(m) ?? 0) + 1);
  }

  #decFilter(event, models) {
    const entry = this.#listenerIndex.get(event);
    if (!entry) return;
    for (const m of models) {
      const c = (entry.byModel.get(m) ?? 0) - 1;
      if (c <= 0) entry.byModel.delete(m); else entry.byModel.set(m, c);
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
   * Returns true iff any registered listener's filter (or lack thereof) COULD match an event
   * with the given model. Conservative: crud-only filters count as generic. Resolver's
   * #createSystemEvent uses this as the fast-path guard.
   */
  hasListenersFor(event, model) {
    const entry = this.#listenerIndex.get(event);
    if (!entry) return false;
    if (entry.genericCount > 0) return true;
    if (model != null && entry.byModel.get(`${model}`) > 0) return true;
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

  /**
   * Register a PARTICIPANT (see class doc). `filter` is an event name (shorthand) or a
   * { event, model, crud, priority, once, memoize } bag — event scalar-or-array required, the
   * rest optional; AND across dimensions, OR within. Returns a disposer that atomically
   * unregisters the whole registration (every event it fanned out to).
   */
  on(filter, listener, ...rest) {
    if (rest.length) throw new TypeError('Emitter.on(event, fn, options) was removed in 0.16 — fold options into the filter: on({ event, priority, memoize }, fn)');
    return this.#register('participant', filter, listener);
  }

  /**
   * Register an OBSERVER: fire-and-forget on every matching event — never awaited, failures
   * isolated, return value ignored, detached resolver in `event.resolver`. Same filter contract
   * and disposer return as on().
   */
  observe(filter, listener, ...rest) {
    if (rest.length) throw new TypeError('Emitter.observe(event, fn, options) was removed in 0.16 — fold options into the filter: observe({ event, priority, memoize }, fn)');
    return this.#register('observer', filter, listener);
  }

  #register(role, filterInput, listener) {
    if (typeof listener !== 'function') throw new TypeError(`Emitter listener must be a function (received ${typeof listener})`);
    const { events, models, cruds, opts, once } = normalizeFilter(filterInput);

    const registrations = []; // [eventName, target] pairs — what the disposer must unwind
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      registrations.forEach(([eventName, target]) => this.removeListener(eventName, target));
    };

    const filtered = Boolean(models || cruds);
    events.forEach((eventName) => {
      let target;
      if (!filtered && !once) {
        // Bare registration — no wrapper at all (non-query events like 'setup' depend on this;
        // a predicate reading event.query would never match them).
        target = prepareListener(listener, opts, role);
        this.#incGeneric(eventName);
      } else {
        const matches = event => (!models || models.includes(`${event?.query?.model}`))
          && (!cruds || cruds.includes(event?.query?.crud));
        // Observers are always invoked (event)-only; participants keep their declared call
        // convention (the legacy done-callback form is mirrored by arity so emit() reads the
        // right convention off the wrapper — a non-matching legacy participant must still
        // next() or the event would hang).
        const wrapper = (role === 'observer' || listener.length < 2) ? (event) => {
          if (!matches(event)) return undefined;
          if (once) dispose(); // remove BEFORE invoking — preserves the old once*/observeOnce semantic
          return listener(event);
        } : (event, next) => {
          if (!matches(event)) return next();
          if (once) dispose();
          return listener(event, next);
        };
        // Without this back-link, removeListener(event, originalFn) could never find the wrapper
        // (same convention the memoize wrappers rely on).
        wrapper.listener = listener;
        target = prepareListener(wrapper, opts, role);
        if (models) {
          this.#wrapperFilter.set(target, models);
          this.#incFilter(eventName, models);
        } else {
          // crud-only (or bare-once) filters index as generic — conservative: hasListenersFor
          // may say yes for a query the crud predicate then rejects, never no for one it runs.
          this.#incGeneric(eventName);
        }
      }
      registrations.push([eventName, target]);
      this.#invalidate(eventName);
      super.on(eventName, target);
    });

    return dispose;
  }

  removeListener(event, listener) {
    // Find the matching registered listener (might be a memoize wrapper around the original).
    // Node's EventEmitter resolves both direct-reference and .listener-equality matches.
    const raw = this.rawListeners(event).find(l => l === listener || l.listener === listener);
    if (raw) {
      const models = this.#wrapperFilter.get(raw);
      if (models) {
        this.#decFilter(event, models);
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
        const models = this.#wrapperFilter.get(raw);
        if (models) {
          this.#decFilter(event, models);
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

  /* ---- removed in 0.16: poisoned, not deleted — the EventEmitter base class would otherwise
     resurface these with NO role stamping and NO fast-path index bookkeeping (silently broken
     listeners). Loud beats silent. ---- */
  /* eslint-disable class-methods-use-this */
  once() { throw new Error('Emitter.once() was removed in 0.16 — use on({ event, once: true }, fn)'); }

  addListener() { throw new Error('Emitter.addListener() was removed in 0.16 — use on(filter, fn)'); }

  prependListener() { throw new Error('Emitter.prependListener() was removed in 0.16 — use on({ event, priority: <n> }, fn)'); }

  prependOnceListener() { throw new Error('Emitter.prependOnceListener() was removed in 0.16 — use on({ event, priority: <n>, once: true }, fn)'); }

  onModels() { throw new Error('Emitter.onModels() was removed in 0.16 — use on({ event, model }, fn)'); }

  onceModels() { throw new Error('Emitter.onceModels() was removed in 0.16 — use on({ event, model, once: true }, fn)'); }

  onKeys() { throw new Error('Emitter.onKeys() was removed in 0.16 — use on({ event, model, crud }, fn); query.key was model+crud composed'); }

  onceKeys() { throw new Error('Emitter.onceKeys() was removed in 0.16 — use on({ event, model, crud, once: true }, fn)'); }

  observeOnce() { throw new Error('Emitter.observeOnce() was removed in 0.16 — use observe({ event, once: true }, fn)'); }

  observeModels() { throw new Error('Emitter.observeModels() was removed in 0.16 — use observe({ event, model }, fn)'); }

  observeKeys() { throw new Error('Emitter.observeKeys() was removed in 0.16 — use observe({ event, model, crud }, fn)'); }
  /* eslint-enable class-methods-use-this */

  static sort(a, b) {
    if (a.priority > b.priority) return -1;
    if (a.priority < b.priority) return 1;
    return 0;
  }
}

module.exports = new Emitter().setMaxListeners(100);
