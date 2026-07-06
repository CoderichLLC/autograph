# AG17 Backlog: `needs` Declaration in the Emitter Filter Bag

**Status:** Backlog — approved direction, deliberately NOT for 0.16 (event-contract break)
**Date:** 2026-07-05
**Context:** Follow-on to the 0.16 performance-baseline initiative (pre-image elision).

## The idea

Mutation-lifecycle listeners declare what they consume at registration, in the filter bag
they already use:

```js
Emitter.on({ event: 'preMutation', model: 'Person', needs: ['doc'] }, fn);
```

At the AG17 contract flip, `query.doc`/`query.merged` become **opt-in**: a listener that
does not declare `needs: ['doc']` sees them as `undefined` on every mutation event. The
pre-image fetch becomes truly demand-driven — the framework fetches when (and only when) a
doc-reading pipeline requires it OR a registered, matching listener declared the need.

**Tethering:** `doc` and `merged` are one declaration — asking for `doc` provisions both
(`merged` is input overlaid on doc; they are the same fetch). `needs: ['doc']` is the only
spelling; there is no separate `merged` need.

## Why this shape (and not arity/signature inference)

`(event, data!)` is not valid JavaScript; the real alternatives are `fn.toString()`
sniffing or arity-counting — and the 0.16 Emitter redesign's first principle, learned the
hard way, is **role/behavior declared at registration, never inferred from arity**. The
filter bag is the settled expression of declared-at-registration: statically indexable
(the elision guard becomes an O(1) lookup into a needs-index instead of the 7-event
presence sweep), survives wrapped/curried/bound listeners, and rides the exact machinery
`{ event, model, crud, priority, once, memoize }` already flows through.

## What this replaces — and what it deliberately does NOT

Replaces exactly ONE predicate: inside `$model.preImage` (SchemaParser.js), the
`Emitter.MUTATION_EVENTS.some(e => Emitter.hasListenersFor(e, model))` presence sweep
becomes "any registered listener whose filter matches this model AND whose `needs`
includes doc." The slot, its call sites, and the `doc === undefined ⇔ elided` contract are
untouched — the 0.16 seam was built so this predicate is swappable in place.

Does NOT replace (listeners are only one of the two pre-image consumers):
- `docSafe` pipeline metadata + `updateDocFree`/`deleteDocFree` parse-time flags —
  pipelines (`immutable`, `selfless`, custom fns) consume `query.doc` independently of any
  listener; `needs` declarations say nothing about them.
- The returning-writes driver contract (updateOne → post-image, deleteOne → pre-image).
- The Driver-call budgets section and bench harness (they become the acceptance tests for
  the tightened predicate: a needs-less listener on the Budget model should KEEP the
  1-call budget — the test that currently asserts listener-suspends-elision flips meaning
  and must be updated deliberately at the AG17 flip).

## Design points to settle at implementation time

- **Timing across the durability layer:** a `needs: ['doc']` listener on `postCommit`/
  `postRollback` forces the fetch at MUTATION time (the pre-image must be captured before
  the write) — the needs-index is consulted exactly where the presence sweep is today.
- **Breaking-change surface:** every existing hook reading `event.query.doc`/`merged`
  breaks silently-ish (sees `undefined`) unless it declares. Migration: a boot-time
  deprecation mode in late 0.16.x? A lint/grep sweep of first-party listeners? Decide then.
- **`preImage` interplay:** with needs-declaration live, the guard gets *more* precise for
  free; also revisit the recorded `deleteDocFree` follow-up (dead flag; delete elision
  currently piggybacks the `updateDocFree`-selected slot) — the needs-index may make a
  dedicated delete predicate trivial enough to wire in the same pass.
- **Churn caution:** the Emitter API was already overhauled once in this release cycle
  (on/observe filter-bag collapse). Batch this flip with whatever else AG17 breaks in the
  event contract — one migration, not two.
