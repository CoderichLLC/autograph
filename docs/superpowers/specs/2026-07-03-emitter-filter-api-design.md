# Emitter filter-object API — design spec

**Date:** 2026-07-03
**Status:** Implemented (2026-07-03)
**Scope:** `workspace/autograph/src/data/Emitter.js` + full call-site sweep (tests, TestSuite, docs)
**Release:** 0.16 (breaking window open; Emitter registration semantics already rewritten this release)

## Motivation

The Emitter exposes ~16 methods, 13 of which are registration variants forming an incomplete
matrix: `{participant, observer} × {generic, models, keys} × {persistent, once}` plus two legacy
`prepend*` cells. The matrix has holes (no `observeOnceModels`, no once-variant of `observeKeys`)
and every hole is a user papercut. The variants are parameters pretending to be method names.

Collapsing to two methods also adds genuinely new power:

- **`crud` as a filter dimension** — authors currently branch on `event.query.crud` inside hook
  bodies (create vs update vs delete). Lifting it into the filter skips the listener body
  entirely for irrelevant ops.
- **`event` plurality (array form)** — one hook spanning `postCommit` + `postRollback` (the
  compensation pair) is impossible today without double registration and double cleanup.
- **Atomic disposal** — a returned unsubscribe function replaces N `removeListener` calls for a
  registration that fans out across N events.

## Public API

Exactly two registration methods. The method name IS the role (consistent with the 0.16 role
doctrine: role is declared at registration, never inferred).

```js
Emitter.on(filter, listener)       // PARTICIPANT: awaited, ambient resolver, throw aborts a
                                   // carried unit, non-undefined return short-circuits
Emitter.observe(filter, listener)  // OBSERVER: fire-and-forget, detached resolver, failures
                                   // isolated, return ignored, initiated first
```

### The filter object

```js
{
  event: 'postCommit' | ['postCommit', 'postRollback'],  // REQUIRED, scalar-or-array
  model: 'Person' | ['Person', 'Book'],                  // optional
  crud:  'cu' | ['create', 'update'],                    // optional; flag string OR word array
  priority: 10,     // registration option (higher runs earlier within its role) — default 0
  once: true,       // self-remove after the FIRST MATCHING emit, across ALL the registration's events
  memoize: true,    // per-(resolver, cache-key) memoization, as today
}
```

- **Matching:** AND across dimensions, OR within a dimension.
  `{ model: ['Person','Book'], crud: 'cu' }` = (Person ∨ Book) ∧ (create ∨ update).
  An absent dimension matches everything.
- **Scalar-or-array leniency** on `event`/`model`/`crud` — singular key names, poly values (`Util.ensureArray` at
  registration; registration is cold-path).
- **`crud` spellings:** flag string of `c|r|u|d` characters, or array of
  `create|read|update|delete` words. Both normalize to the word set internally.
- **String shorthand:** `Emitter.on('setup', fn)` ≡ `Emitter.on({ event: 'setup' }, fn)`.
  Preserves EventEmitter muscle memory for the most common registration. The shorthand takes NO
  third options argument — the moment you need `priority`/`once`/`memoize` or any filter
  dimension, you use the object form (one bag, one place; the old `on(event, fn, options)`
  trailing-options signature is removed with the rest of the variants).
- **Return value:** an unsubscribe function that disposes the entire registration (all events)
  atomically. `removeListener(event, originalFn)` continues to work per event via the
  `wrapper.listener` back-link — the disposer is the promoted pattern, not the only one.

### Registration-time validation (loud, consistent with the Vocabulary doctrine)

All thrown synchronously at registration — the cheap place to be strict:

- Unknown filter keys throw (e.g. plural `models:` typo → error naming the allowed keys, never
  a silent match-all listener).
- Unknown crud letters/words throw.
- Missing/empty `event` throws.
- Non-function listener throws.
- Empty `model`/`crud` arrays throw (a structurally-detectable silent never-match).
- A third argument to `on()`/`observe()` throws (the old trailing-options signature must fail loud, not silently drop priority/memoize).

### Removed (BREAKING)

`addListener`, `once`, `prependListener`, `prependOnceListener`, `onKeys`, `onceKeys`,
`onModels`, `onceModels`, `observeOnce`, `observeKeys`, `observeModels`.

- `once`/`observeOnce`/`onceKeys`/`onceModels` → `{ once: true }` in the bag.
- `prepend*` → subsumed by `priority` (it was already the honest mechanism; prepend order was a
  fiction once priority sorting existed).
- `onModels`/`observeModels` → the `model:` dimension.
- `onKeys`/`onceKeys`/`observeKeys` → `model:` + `crud:` composed. There is NO `keys` filter
  dimension: `query.key` is the derived composite `verb + Model` (`createPerson`, `pushPerson`,
  `getPerson`) — a composite of two axes the filter already has separately, which is why
  `{ model: 'A', keys: 'updateB' }` could only ever mean the empty set. Granularity `crud`
  erases (get vs find vs count; push/pull/splice vs update) remains available in-body via
  `event.query.key`/`event.query.op`; if filter-level need emerges later, the coherent spelling
  is an `op` dimension matching `query.op` (a pure verb axis), never `keys`.

### Kept (unchanged)

`emit`, `hasListenersFor(event, model)` (the `key` parameter drops with the `byKey` index), `removeListener`/`off`/`removeAllListeners`
(low-level removal primitives), and every emit-side semantic: role dispatch order (observers
first, then participants in one flat priority order), sync-return short-circuit, resolved-value
short-circuit race, legacy `(event, next)` done-callback call convention, memoize wrapper
behavior, and the event payload shape (`{ schema, context, resolver, query }` — one object per
lifecycle, identical across all events including `postCommit`/`postRollback`).

## Internals

- **One compiled predicate per registration.** At registration, normalize the filter and build
  a single `matches(query)` closure (models/crud set membership). No per-emit object
  allocation or re-parsing.
- **One wrapper per event.** Node's `EventEmitter` remains the storage (`extends EventEmitter`
  stays, as internal machinery). A registration with `event: [a, b]` registers one wrapper on
  each; all wrappers share the predicate, the `once` latch, and the disposer.
  `wrapper.listener = original` on each (removeListener compatibility, same convention the
  memoize wrappers already rely on).
- **`once` across events:** a shared latch — the first MATCHING emit on ANY of the
  registration's events runs the listener and disposes ALL the registration's wrappers (via the
  same disposer the caller gets). Wrapper self-removal on match (never `super.once`) preserves
  today's "only counts on a MATCHING event" semantic.
- **Fast-path index (`hasListenersFor`)** SIMPLIFIES: with `keys` gone the `byKey` map dies.
  Each per-event wrapper indexes under `model` → `byModel` counts when present, else →
  `genericCount` (generic and crud-only filters alike). Conservative is correct:
  `hasListenersFor` may answer "yes" for a listener whose crud predicate then rejects the query,
  but never "no" for a listener that would run. `hasListenersFor(event, model, key)` →
  `(event, model)`; Resolver call sites updated in the sweep. (Indexing crud is a later
  optimization if measured — `Resolver` has `query.crud` in hand at the call site.)
- **Disposer** decrements the same index entries it incremented and removes each wrapper —
  idempotent (second call is a no-op).

## Migration sweep

Mechanical rewrites, no semantic changes:

| Before | After |
| --- | --- |
| `Emitter.on('setup', fn)` | unchanged (shorthand) |
| `Emitter.once('preQuery', fn)` | `Emitter.on({ event: 'preQuery', once: true }, fn)` |
| `Emitter.onModels('postCommit', ['Person'], fn)` | `Emitter.on({ event: 'postCommit', model: 'Person' }, fn)` |
| `Emitter.onKeys('postMutation', ['createPerson'], fn)` | `Emitter.on({ event: 'postMutation', model: 'Person', crud: 'c' }, fn)` |
| `Emitter.observeModels('postCommit', ['Person'], fn)` | `Emitter.observe({ event: 'postCommit', model: 'Person' }, fn)` |
| `Emitter.prependListener('validate', fn)` | `Emitter.on({ event: 'validate', priority: 1 }, fn)` (any value above the default 0) |
| `Emitter.on('validate', fn, { memoize: true })` | `Emitter.on({ event: 'validate', memoize: true }, fn)` |

Sweep targets: `workspace/autograph/test/**` (heavy usage: Resolver.test, TransactionScope.test,
OperationScope.test, Emitter tests, WhereVocabulary.test), `workspace/testsuite/TestSuite.js`,
driver-package tests, and doc examples (CLAUDE.md Emitter section + event examples,
TRANSACTIONS.md role vocabulary, CHANGELOG v0.16.x Emitter block gets a line).

## Testing plan

New/updated Emitter test coverage pinning:

1. Events plurality — one registration fires on both `postCommit` and `postRollback`; disposer
   removes both.
2. `crud` filtering — both spellings (`'cu'` and `['create','update']`), listener body never
   runs for filtered-out ops.
3. AND-across / OR-within matching semantics.
4. `once` across events — first matching emit on either event disposes the whole registration.
5. Unsubscribe disposer — atomic, idempotent; `removeListener(event, fn)` still works per event.
6. Registration-time rejections — unknown filter key, unknown crud flag, empty events,
   string+object equivalence of the shorthand.
7. `hasListenersFor(event, model)` fast-path correctness for filtered registrations (never a
   false "no"; crud-only counts as generic; `byKey` index removed).
8. Role semantics preserved through the new registration path (participant short-circuit/abort;
   observer isolation/detached resolver) — the existing role tests re-pointed at the new API are
   the regression net.

## Non-goals

- No emit-side changes (dispatch, roles, short-circuit, payload).
- No new filter dimensions beyond `event`/`model`/`crud` (no `keys` — see Removed; a pure-verb `op` dimension is the sanctioned future addition if needed) (e.g. no predicates-as-functions
  in the filter — YAGNI; the listener body can do anything residual).
- No back-compat aliases for the removed methods (0.16 is the breaking window; aliases would
  defeat the collapse).
