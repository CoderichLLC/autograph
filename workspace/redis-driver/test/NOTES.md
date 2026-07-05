# What building a Redis driver proved about the AG driver contract

This package was built as a deliberate experiment: take the least database-like store in common
use — a key/value server with no query language, no interactive transactions, no joins — and make
it a full AG citizen. The question behind it: *is a driver's use-case an open design question, or
does the framework answer it?* Verdict: **the framework answers it.** The TestSuite plus the
Where Vocabulary ARE the spec; a driver is an implementation of AG's storage semantics on a
substrate, never an exposure of the substrate's own personality.

## The floor, empirically confirmed

A store that can offer only CRUD, enumeration, and single-key atomicity passes the full
conformance suite by providing exactly six things:

1. **Document CRUD by collection** — one JSON blob per `<model>:<id>` key.
2. **Enumeration** — a `<model>:__ids` set; every read is scan → filter → sort → paginate.
3. **Vocabulary semantics** — evaluated entirely client-side (~150 lines: operators, globs,
   portable null rules, Mongo array-element matching, dotted-path descent through embedded
   arrays). WHERE evaluation location is the driver's business; the semantics are not.
4. **Deterministic sort + pagination** — type-aware comparator; inclusive cursor bounds
   (`after`/`before` are decoded sort-value objects; the DataLoader trims bookends above).
5. **Unique index enforcement** — maintained hash structures, checked-and-written atomically in
   one Lua script per write; duplicate errors match `/duplicate/i`.
6. **Insertion-ordered IDs** — the harness generator contract every non-Mongo driver carries.

Everything else — validation, pipelines, embedded semantics, RI, events, per-request caching,
**joins** (QueryPlanner pre-query/`$in` fallback; this driver never sees `query.joins`), and
**transaction scoping** (inert for this source) — is framework-owned and simply worked.

## What the exercise forced INTO the framework (the real yield)

- **The conformance suite became capability-aware.** `testSuite({ supports })` mirrors the
  consumer's declaration: sections asserting transactional semantics bind only drivers that
  declare `'transactions'`; without it the suite runs the *uncarried-semantics* variant —
  asserting the doctrine (writes durable when awaited, `commit()` no-op, `rollback()` cannot
  undo, settled scopes fully inert) rather than skipping. The `supports: []` mode of the
  framework now has a conformance section of its own.
- **QueryPlanner grew multi-hop join-shaped SORT resolution.** `sortBy({ authored: { chapters:
  { name } } })` sorts by a sub-path that crosses a second FK link inside the foreign model;
  the planner now recurses hop by hop (batch-fetch per level) and reduces multi-values
  direction-aware (min for asc, max for desc — the unwind→sort→first-occurrence semantics a
  joining driver produces).
- **A latent augment-key collision was exposed and fixed.** Cross-source sort augment values
  were keyed by the path's first segment, so two sort keys sharing a prefix
  (`authored.chapters.name` + `authored.chapters.temp`) clobbered each other — silent id-order
  degradation. Only a driver living permanently on the planner fallback could surface it.

## Honest limitations (by design, not gaps)

- **Scan-first**: every query is O(collection). This driver is a document substrate for modest
  collections, not a query engine — Redis Stack (RedisJSON/RediSearch) would be a different
  driver with a real dialect translation.
- **`rollback()` cannot undo** and updateOne's read→merge→write window is real — declaring
  `supports: []` is consenting to exactly this class of anomaly. Each individual write IS
  atomic (Lua), so unique indexes never tear.
- **Raw-driver escape hatches skip index maintenance** (`global.rawDriver` is a test-harness
  concern, mirroring the other packages).

## Observations for the backlog

- The in-driver vocabulary evaluator is the third sibling of PostgresDriver's `applyJsFilters`
  and QueryPlanner's in-memory sort/paginate. The case for a shared in-memory query package
  (`match(doc, where)` + comparator) is now concrete — extraction awaits its second consumer
  per the workspace's own rule, and this driver is that consumer's shape.
- Zero emulation shim was needed: `redis-memory-server` runs a real `redis-server`, so the
  suite tests real semantics — a fidelity bar worth aspiring to for the PG harness (pg-mem's
  shim emulates transactions and savepoints).
