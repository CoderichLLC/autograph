# Emitter Filter-Object API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the Emitter's 13 registration variants into `on(filter, fn)` / `observe(filter, fn)` with a `{ event, model, crud, priority, once, memoize }` filter bag, per the approved spec at `docs/superpowers/specs/2026-07-03-emitter-filter-api-design.md`.

**Architecture:** One private `#register(role, filter, listener)` powers both public methods. Filters normalize/validate at registration (cold path) into a compiled predicate; one wrapper registers per event name on the underlying Node `EventEmitter`. The `byKey` fast-path index dies; `hasListenersFor` narrows to `(event, model)`. Removed methods become poison stubs (they'd otherwise silently resurface from the `EventEmitter` base class with no role stamping). Emit-side dispatch is untouched.

**Tech Stack:** Node 18.12.1, Jest (run from `workspace/autograph`), ESLint airbnb-base, `@coderich/util` (`Util.ensureArray`, `Util.isPlainObject`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-03-emitter-filter-api-design.md` — the contract; on conflict, the spec wins.
- Emit-side semantics MUST NOT change: observer-first dispatch, flat priority order per role, sync-return short-circuit, resolved-value race, legacy `(event, next)` call convention by arity, memoize wrappers, event payload shape.
- All jest commands run from `workspace/autograph` (or the named driver workspace) — running from repo root fails (no service setup).
- `.testSKIP.js` files are excluded from the run but get swept for consistency.
- Baselines: autograph 237 tests green, lint 0 errors/13 warnings; mongo-driver 100/101 and postgres-driver 100/101 (1 pre-existing skip each).
- COMMITS: per Richard's workflow, STOP at each commit step and offer the pre-commit review (per `~/.claude/CLAUDE.md`); do not commit or push without his explicit go-ahead.
- Intermediate state: Task 1's commit gate leaves `Resolver.test.js`/`OperationScope.test.js`/TestSuite red (they still call removed methods) — expected; Task 2/3 restore green. Do not push between tasks.

---

### Task 1: Emitter core rewrite + Emitter.test.js rewrite

**Files:**
- Modify: `workspace/autograph/src/data/Emitter.js` (registration section, lines ~140-451; emit() untouched)
- Test: `workspace/autograph/test/data/Emitter.test.js` (full registration-API rewrite)

**Interfaces:**
- Consumes: existing `prepareListener(listener, opts, role)`, `#getListeners`, `emit`, `AbortEarlyError` — all unchanged.
- Produces (later tasks rely on):
  - `Emitter.on(filterOrEvent, listener) → dispose()` — participant registration
  - `Emitter.observe(filterOrEvent, listener) → dispose()` — observer registration
  - filter: `{ event: string|string[], model?: string|string[], crud?: string|string[], priority?: number, once?: boolean, memoize?: boolean }`
  - `Emitter.hasListenersFor(event, model) → boolean` (key param GONE)
  - `Emitter.removeListener(event, originalFn)` / `off` / `removeAllListeners` — unchanged signatures
  - Removed methods throw: `once`, `addListener`, `prependListener`, `prependOnceListener`, `onModels`, `onceModels`, `onKeys`, `onceKeys`, `observeOnce`, `observeModels`, `observeKeys`

- [ ] **Step 1: Rewrite `test/data/Emitter.test.js`**

Replace every registration in the existing role/dispatch/priority/memoize tests with the new API, and add a new `describe` for the filter API itself. Existing tests translate mechanically — the assertions do not change:

| Old registration in test | New registration |
| --- | --- |
| `Emitter.on('order', fn1)` | unchanged (string shorthand) |
| `Emitter.once('once', fn)` | `Emitter.on({ event: 'once', once: true }, fn)` |
| `Emitter.onModels('onModels', 'key', fn)` | `Emitter.on({ event: 'onModels', model: 'key' }, fn)` |
| `Emitter.onceModels('preMutation', ['Person'], fn)` | `Emitter.on({ event: 'preMutation', model: 'Person', once: true }, fn)` |
| `Emitter.onKeys('onKeys', 'key', fn)` | DELETE the onKeys/onceKeys variant tests (keys dimension is gone); the `basicAbort` test's `Emitter.onKeys('basicAbort', 'key', fn1)` becomes `Emitter.on({ event: 'basicAbort', model: 'M' }, fn1)` with its emit payload changed to `{ query: { model: 'M' } }` |
| `Emitter.observeOnce('obsOnce', fn)` | `Emitter.observe({ event: 'obsOnce', once: true }, fn)` |
| `Emitter.observeModels('obsModels', ['M'], fn)` | `Emitter.observe({ event: 'obsModels', model: 'M' }, fn)` |
| `Emitter.prependListener('event', fn3)` | `Emitter.on({ event: 'event', priority: 1 }, fn3)` (assertions keep fn3-first ordering) |
| `Emitter.prependListener('event', fn31, { priority: -Infinity })` | `Emitter.on({ event: 'event', priority: -Infinity }, fn31)` |
| `Emitter.on('event', fn21, { priority: 1 })` | `Emitter.on({ event: 'event', priority: 1 }, fn21)` |
| `Emitter.on('memoBasic', fn, { memoize: true })` | `Emitter.on({ event: 'memoBasic', memoize: true }, fn)` |
| `Emitter.onModels('removeMeBasic', ['M'], fn)` | `Emitter.on({ event: 'removeMeBasic', model: 'M' }, fn)` (removeListener assertions unchanged) |
| `Emitter.onKeys('removeMeKeys', ['someKey'], fn)` | DELETE (covered by the model-filter removal test) |

New filter-API describe (add verbatim):

```js
describe('filter-object registration (0.16 API)', () => {
  afterEach(() => {
    ['fEvents', 'fEvents2', 'fCrud', 'fAnd', 'fOnce', 'fDispose', 'fShort'].forEach(e => Emitter.removeAllListeners(e));
  });

  test('event plurality: one registration fires on every listed event; disposer removes all', async () => {
    const seen = [];
    const off = Emitter.on({ event: ['fEvents', 'fEvents2'] }, event => { seen.push(event.tag); });
    await Emitter.emit('fEvents', { tag: 'a' });
    await Emitter.emit('fEvents2', { tag: 'b' });
    expect(seen).toEqual(['a', 'b']);
    off();
    await Emitter.emit('fEvents', { tag: 'c' });
    expect(seen).toEqual(['a', 'b']); // disposed everywhere
    off(); // idempotent — second call is a no-op
  });

  test('crud filter: both spellings; body never runs for filtered-out ops', async () => {
    const seen = [];
    Emitter.on({ event: 'fCrud', crud: 'cu' }, e => { seen.push(`flags:${e.query.crud}`); });
    Emitter.on({ event: 'fCrud', crud: ['create', 'update'] }, e => { seen.push(`words:${e.query.crud}`); });
    await Emitter.emit('fCrud', { query: { crud: 'create' } });
    await Emitter.emit('fCrud', { query: { crud: 'read' } }); // filtered out by both
    await Emitter.emit('fCrud', { query: { crud: 'update' } });
    expect(seen.sort()).toEqual(['flags:create', 'flags:update', 'words:create', 'words:update']);
  });

  test('AND across dimensions, OR within: { model: [A,B], crud: c }', async () => {
    const seen = [];
    Emitter.on({ event: 'fAnd', model: ['A', 'B'], crud: 'c' }, e => { seen.push(`${e.query.model}:${e.query.crud}`); });
    await Emitter.emit('fAnd', { query: { model: 'A', crud: 'create' } }); // match
    await Emitter.emit('fAnd', { query: { model: 'C', crud: 'create' } }); // model rejects
    await Emitter.emit('fAnd', { query: { model: 'B', crud: 'update' } }); // crud rejects
    await Emitter.emit('fAnd', { query: { model: 'B', crud: 'create' } }); // match
    expect(seen).toEqual(['A:create', 'B:create']);
  });

  test('once across events: first MATCHING emit on ANY event disposes the whole registration', async () => {
    const seen = [];
    Emitter.on({ event: ['fOnce', 'fEvents'], model: 'M', once: true }, e => { seen.push(e.query.model); });
    await Emitter.emit('fOnce', { query: { model: 'X' } }); // non-matching: does NOT consume the once
    await Emitter.emit('fEvents', { query: { model: 'M' } }); // consumes — disposes BOTH wrappers
    await Emitter.emit('fOnce', { query: { model: 'M' } });
    expect(seen).toEqual(['M']);
  });

  test('string shorthand ≡ { event }: registration and removeListener both work', async () => {
    const seen = [];
    const fn = event => { seen.push(event.tag); };
    Emitter.on('fDispose', fn);
    await Emitter.emit('fDispose', { tag: 'x' });
    Emitter.removeListener('fDispose', fn);
    await Emitter.emit('fDispose', { tag: 'y' });
    expect(seen).toEqual(['x']);
  });

  test('a filtered participant still short-circuits and aborts like a bare one', async () => {
    Emitter.on({ event: 'fShort', model: 'M' }, () => 'veto');
    await expect(Emitter.emit('fShort', { query: { model: 'M' } })).resolves.toBe('veto');
    await expect(Emitter.emit('fShort', { query: { model: 'X' } })).resolves.toBeUndefined();
  });

  describe('registration-time validation (loud)', () => {
    test('unknown filter keys throw, naming the allowlist', () => {
      expect(() => Emitter.on({ event: 'x', models: 'P' }, () => {})).toThrow(/Unknown Emitter filter key.*models.*allowed: event, model, crud, priority, once, memoize/);
    });
    test('unknown crud flags/words throw', () => {
      expect(() => Emitter.on({ event: 'x', crud: 'cz' }, () => {})).toThrow(/Unknown crud filter "z"/);
      expect(() => Emitter.on({ event: 'x', crud: ['upsert'] }, () => {})).toThrow(/Unknown crud filter "upsert"/);
    });
    test('missing/empty event throws; non-function listener throws; non-object filter throws', () => {
      expect(() => Emitter.on({ model: 'P' }, () => {})).toThrow(/at least one event/);
      expect(() => Emitter.on({ event: [] }, () => {})).toThrow(/at least one event/);
      expect(() => Emitter.on('x', 'nope')).toThrow(/listener must be a function/);
      expect(() => Emitter.on(42, () => {})).toThrow(/event name or filter object/);
    });
  });

  describe('removed methods are poisoned (base EventEmitter must not silently resurface them)', () => {
    test.each([
      ['once', /once\(\) was removed in 0\.16.*once: true/],
      ['addListener', /addListener\(\) was removed in 0\.16/],
      ['prependListener', /prependListener\(\) was removed in 0\.16.*priority/],
      ['prependOnceListener', /prependOnceListener\(\) was removed in 0\.16/],
      ['onModels', /onModels\(\) was removed in 0\.16.*model/],
      ['onceModels', /onceModels\(\) was removed in 0\.16/],
      ['onKeys', /onKeys\(\) was removed in 0\.16.*model.*crud/],
      ['onceKeys', /onceKeys\(\) was removed in 0\.16/],
      ['observeOnce', /observeOnce\(\) was removed in 0\.16/],
      ['observeModels', /observeModels\(\) was removed in 0\.16/],
      ['observeKeys', /observeKeys\(\) was removed in 0\.16/],
    ])('%s() throws with migration guidance', (name, re) => {
      expect(() => Emitter[name]('x', () => {})).toThrow(re);
    });
  });

  describe('hasListenersFor(event, model) — byKey index removed', () => {
    test('model-filtered → indexed by model; crud-only → generic (conservative); disposal decrements', () => {
      const off1 = Emitter.on({ event: 'fIdx', model: 'P' }, () => {});
      expect(Emitter.hasListenersFor('fIdx', 'P')).toBe(true);
      expect(Emitter.hasListenersFor('fIdx', 'Q')).toBe(false);
      const off2 = Emitter.on({ event: 'fIdx', crud: 'c' }, () => {});
      expect(Emitter.hasListenersFor('fIdx', 'Q')).toBe(true); // crud-only counts generic — conservative
      off2();
      expect(Emitter.hasListenersFor('fIdx', 'Q')).toBe(false);
      off1();
      expect(Emitter.hasListenersFor('fIdx', 'P')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `cd workspace/autograph && npx jest test/data/Emitter.test.js 2>&1 | tail -5`
Expected: FAIL — new filter-API tests error (object filters rejected by old `on`), poison tests fail (old methods still work).

- [ ] **Step 3: Rewrite the registration section of `src/data/Emitter.js`**

3a. Add normalization helpers after `prepareListener` (module scope):

```js
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
  let cruds = null;
  if (filter.crud != null) {
    // Word array, single word, or a flag string of c|r|u|d characters — all normalize to words.
    const parts = Array.isArray(filter.crud) ? filter.crud : (CRUD_WORDS.includes(filter.crud) ? [filter.crud] : `${filter.crud}`.split(''));
    cruds = parts.map((part) => {
      const word = CRUD_WORDS.includes(part) ? part : CRUD_FLAGS[part];
      if (!word) throw new TypeError(`Unknown crud filter "${part}" — allowed: flag string of [${Object.keys(CRUD_FLAGS).join('')}] or words [${CRUD_WORDS.join(', ')}]`);
      return word;
    });
  }
  return { events, models, cruds, opts: { priority: filter.priority, memoize: filter.memoize }, once: Boolean(filter.once) };
};
```

3b. Replace the entire block of registration methods (`on`, `addListener`, `once`, `prependListener`, `prependOnceListener`, `observe`, `observeOnce`, `onKeys`, `onceKeys`, `onModels`, `onceModels`, `observeKeys`, `observeModels`, and `#createWrapper`) with the code below. Also DELETE the now-dead module-scope `normalizeOptions` helper (only the old methods used it — leaving it trips `no-unused-vars`):

```js
  /**
   * Register a PARTICIPANT (see class doc). `filter` is an event name (shorthand) or a
   * { event, model, crud, priority, once, memoize } bag — event scalar-or-array required, the
   * rest optional; AND across dimensions, OR within. Returns a disposer that atomically
   * unregisters the whole registration (every event it fanned out to).
   */
  on(filter, listener) {
    return this.#register('participant', filter, listener);
  }

  /**
   * Register an OBSERVER: fire-and-forget on every matching event — never awaited, failures
   * isolated, return value ignored, detached resolver in `event.resolver`. Same filter contract
   * and disposer return as on().
   */
  observe(filter, listener) {
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
```

3c. Add the poison stubs (removed methods MUST throw — deleting them would silently resurface the base `EventEmitter` implementations with no role stamping and no index bookkeeping):

```js
  /* ---- removed in 0.16: poisoned, not deleted — the EventEmitter base class would otherwise
     resurface these with NO role stamping and NO fast-path index bookkeeping (silently broken
     listeners). Loud beats silent. ---- */
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
```

3d. Simplify the index (byKey dies). Replace `#getIndex`/`#incFilter`/`#decFilter`/`hasListenersFor` and the `#wrapperFilter` comment:

```js
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
```

In `removeListener` and `removeAllListeners`, the `#wrapperFilter` value is now the models array itself: `this.#decFilter(event, filter)` replaces `this.#decFilter(event, filter.prop, filter.arr)` (both call sites).

3e. Update the class doc comment (lines ~110-138): registration examples become `on({ event, model, crud }, fn)` / `observe(...)`; note the disposer return and the poison stubs.

- [ ] **Step 4: Run the Emitter suite to verify it passes**

Run: `cd workspace/autograph && npx jest test/data/Emitter.test.js 2>&1 | tail -5`
Expected: PASS (all tests).
Also run: `npx eslint src/data/Emitter.js test/data/Emitter.test.js` — expected: 0 errors.

- [ ] **Step 5: Commit gate**

STOP: offer Richard the pre-commit review per his global CLAUDE.md. On go-ahead:

```bash
git add workspace/autograph/src/data/Emitter.js workspace/autograph/test/data/Emitter.test.js
git commit -m "feat(emitter): collapse registration variants into on/observe filter-object API"
```

Note: `Resolver.test.js` / `OperationScope.test.js` / TestSuite are RED at this point (expected — they call poisoned methods; Tasks 2-3 sweep them). Do not push.

---

### Task 2: Autograph workspace sweep (src + tests) → whole workspace green

**Files:**
- Modify: `workspace/autograph/src/data/Resolver.js:638-647,709` (hasListenersFor call sites)
- Modify: `workspace/autograph/test/data/Resolver.test.js` (29 registrations)
- Modify: `workspace/autograph/test/data/OperationScope.test.js` (10 registrations)
- Modify: `workspace/autograph/test/data/Resolver.testSKIP.js` (9 registrations — excluded from run, swept for consistency)
- Check (likely no-op): `workspace/autograph/test/server.js:11` (bare `Emitter.on(` — shorthand survives unchanged)

**Interfaces:**
- Consumes: Task 1's `on(filter, fn)` / `observe(filter, fn)` / `hasListenersFor(event, model)`.
- Produces: a fully green autograph workspace on the new API.

- [ ] **Step 1: Update Resolver.js fast-path call sites**

At line 638, `qKey` becomes unused — remove it from the destructure, and drop the third argument from all six `hasListenersFor` calls:

```js
    const { model: qModel } = query;
    if (
      !needsValidate
      && !Emitter.hasListenersFor(`pre${type}`, qModel)
      && !Emitter.hasListenersFor(`post${type}`, qModel)
      && !Emitter.hasListenersFor('preResponse', qModel)
      && !Emitter.hasListenersFor('postResponse', qModel)
      // Mutations only: postCommit/postRollback need the full path (an event object to emit with,
      // and the settled registration below). Reads keep their 4-lookup hot path.
      && (type === 'Query' || (!Emitter.hasListenersFor('postCommit', qModel) && !Emitter.hasListenersFor('postRollback', qModel)))
    ) {
```

and at line ~709:

```js
    if (type === 'Mutation' && resultEarly === undefined
      && (Emitter.hasListenersFor('postCommit', qModel) || Emitter.hasListenersFor('postRollback', qModel))) {
```

- [ ] **Step 2: Sweep the test files**

Apply these exact transformations everywhere they appear (arguments preserved verbatim; only the registration call changes). The listener function and all assertions stay untouched:

| Pattern (before) | Replacement (after) |
| --- | --- |
| `Emitter.onModels('EVT', ['A'], fn)` | `Emitter.on({ event: 'EVT', model: 'A' }, fn)` |
| `Emitter.onModels('EVT', ['A', 'B'], fn)` | `Emitter.on({ event: 'EVT', model: ['A', 'B'] }, fn)` |
| `Emitter.observeModels('EVT', ['A'], fn)` | `Emitter.observe({ event: 'EVT', model: 'A' }, fn)` |
| `Emitter.onKeys('EVT', ['createPerson'], fn)` | `Emitter.on({ event: 'EVT', model: 'Person', crud: 'c' }, fn)` |
| `Emitter.onKeys('EVT', ['updatePerson'], fn)` | `Emitter.on({ event: 'EVT', model: 'Person', crud: 'u' }, fn)` |
| `Emitter.onceKeys('EVT', ['createPerson'], fn)` | `Emitter.on({ event: 'EVT', model: 'Person', crud: 'c', once: true }, fn)` |
| `Emitter.onceModels('EVT', ['A'], fn)` | `Emitter.on({ event: 'EVT', model: 'A', once: true }, fn)` |
| `Emitter.once('EVT', fn)` | `Emitter.on({ event: 'EVT', once: true }, fn)` |
| `Emitter.on('EVT', fn, { priority: N })` | `Emitter.on({ event: 'EVT', priority: N }, fn)` |
| `Emitter.on('EVT', fn, { memoize: true })` | `Emitter.on({ event: 'EVT', memoize: true }, fn)` |
| `Emitter.on('EVT', fn)` / `Emitter.observe('EVT', fn)` | unchanged (shorthand) |
| `Emitter.removeListener('EVT', fn)` | unchanged |

CAUTION on `onKeys` rewrites: derive `model` and `crud` from the key's verb+Model composite (`createPerson` → model `Person`, crud `'c'`; `pushX`/`pullX`/`spliceX` → crud `'u'`; `getX`/`findX`/`countX` → crud `'r'`). Do this per call site, not blindly.

- [ ] **Step 3: Verify zero stragglers**

Run: `grep -rn "Emitter\.\(onModels\|onKeys\|onceModels\|onceKeys\|observeModels\|observeKeys\|observeOnce\|once(\|addListener\|prependListener\|prependOnceListener\)" workspace/autograph --include="*.js" | grep -v node_modules | grep -v "src/data/Emitter.js"`
Expected: no output. (Emitter.js itself keeps the names as poison stubs.)

- [ ] **Step 4: Run the full autograph suite**

Run: `cd workspace/autograph && npm test 2>&1 | tail -5`
Expected: 18 suites, 237 tests, all green (same count as baseline — this task changes no behavior).
Run: `npm run lint 2>&1 | tail -3` — expected: 0 errors, 13 warnings (baseline).

- [ ] **Step 5: Commit gate**

STOP: offer the pre-commit review. On go-ahead:

```bash
git add workspace/autograph/src/data/Resolver.js workspace/autograph/test
git commit -m "refactor: sweep autograph src+tests onto the Emitter filter-object API"
```

---

### Task 3: TestSuite + driver workspaces green

**Files:**
- Modify: `workspace/testsuite/TestSuite.js:1208,1332-1334` (1 bare `on` — no-op; 3 `onModels`)

**Interfaces:**
- Consumes: Task 1's API (TestSuite imports `Emitter` from `@coderich/autograph`).
- Produces: green mongo-driver and postgres-driver suites.

- [ ] **Step 1: Sweep TestSuite.js**

Line 1208 `Emitter.on('preQuery', scopingHook)` — shorthand, unchanged. Lines 1332-1334 (exact current code):

```js
      Emitter.onModels('postMutation', ['Person'], hookA);
      Emitter.onModels('postMutation', ['Person'], hookB);
      Emitter.onModels('postMutation', ['Color'], colorChain);
```

become:

```js
      Emitter.on({ event: 'postMutation', model: 'Person' }, hookA);
      Emitter.on({ event: 'postMutation', model: 'Person' }, hookB);
      Emitter.on({ event: 'postMutation', model: 'Color' }, colorChain);
```

Then verify: `grep -n "Emitter\.\(onModels\|onKeys\|observeModels\|observeKeys\|observeOnce\|once(\|prepend\)" workspace/testsuite/TestSuite.js` — expected: no output.

- [ ] **Step 2: Run both driver suites**

Run: `cd workspace/mongo-driver && npm test 2>&1 | tail -4`
Expected: 100 passed, 1 skipped (baseline).
Run: `cd workspace/postgres-driver && npm test 2>&1 | tail -4`
Expected: 100 passed, 1 skipped (baseline).

- [ ] **Step 3: Commit gate**

STOP: offer the pre-commit review. On go-ahead:

```bash
git add workspace/testsuite/TestSuite.js
git commit -m "refactor: sweep TestSuite onto the Emitter filter-object API"
```

---

### Task 4: Docs sync + repo-wide verification

**Files:**
- Modify: `CLAUDE.md` (Emitter key-file bullet ~line 65; "Emitter Events" section examples)
- Modify: `docs/TRANSACTIONS.md` (§4.18 + any `onModels`/`observe*`-variant mentions — locate with the grep below)
- Modify: `workspace/autograph/CHANGELOG.md` (v0.16.x Emitter block)
- Modify: `docs/superpowers/specs/2026-07-03-emitter-filter-api-design.md` (Status → Implemented)

**Interfaces:**
- Consumes: the final shipped API from Tasks 1-3.
- Produces: docs that match the code; a fully green repo.

- [ ] **Step 1: Locate every doc mention**

Run: `grep -rn "onModels\|onKeys\|onceModels\|onceKeys\|observeModels\|observeKeys\|observeOnce\|prependListener" CLAUDE.md docs/ workspace/autograph/CHANGELOG.md`
Rewrite each hit to the new spelling (same table as Task 2). In CLAUDE.md's Emitter key-file bullet, replace the registration-method description: `on(filter, fn)` registers PARTICIPANTS and `observe(filter, fn)` registers OBSERVERS, filter = `{ event, model, crud, priority, once, memoize }` (scalar-or-array values; string shorthand for bare event), returns a disposer; role semantics unchanged. The "Emitter Events" example block (`emitter.on('preQuery', ...)` etc.) is all bare shorthand — unchanged.

- [ ] **Step 2: Add the CHANGELOG line**

In `workspace/autograph/CHANGELOG.md`, inside the v0.16.x "Emitter" block, append:

```markdown
    - Registration collapsed to TWO methods: `on(filter, fn)` / `observe(filter, fn)` — filter = `{ event, model, crud, priority, once, memoize }` (scalar-or-array; string shorthand for bare event; returns a disposer); `once`/`prepend*`/`onModels`/`onKeys`/`observe*` variants REMOVED (poisoned with migration hints); NO `keys` filter (use `model` + `crud`); `hasListenersFor(event, model)` drops the key param
```

- [ ] **Step 3: Full repo verification**

Run: `npm test 2>&1 | tail -5` (repo root — all workspaces)
Expected: all suites green at baseline counts.
Run: `npm run lint 2>&1 | tail -3`
Expected: 0 errors (13 autograph warnings + 1 PG DEBUG_SQL warning = baseline).

- [ ] **Step 4: Commit gate**

STOP: offer the pre-commit review. On go-ahead:

```bash
git add CLAUDE.md docs/ workspace/autograph/CHANGELOG.md
git commit -m "docs: sync Emitter filter-object API across CLAUDE.md, TRANSACTIONS.md, CHANGELOG"
```
