# RedisDriver (`@coderich/autograph-redis`) — Design Spec

**Status:** Implemented (one-shot, 2026-07-04) — see `workspace/redis-driver/` and its `test/NOTES.md`
**Date:** 2026-07-04
**Approach:** Vanilla Redis (no Stack modules) — JSON blob per doc + client-side vocabulary evaluation
**Scope:** Real, publishable driver package with full TestSuite conformance

## Purpose

Add a Redis-backed driver to the workspace, both as a real driver and as a proof of the
driver contract's floor: a store that offers nothing but CRUD, enumeration, and atomic
single-key operations — no server-side query language, no interactive transactions, no joins —
must still be a complete AG citizen by honestly declaring `supports: []` and letting the
framework's fallbacks (QueryPlanner join resolution, inert transaction scopes) carry the rest.

The exercise's thesis (validated in design discussion): an AG driver is never "how do I expose
my store's nature" — it is "how do I implement AG's storage semantics on my substrate." The
TestSuite + Where Vocabulary ARE the spec; the driver contract obligations are:

1. Document CRUD by collection
2. Enumeration with arbitrary predicates (you must be able to scan)
3. Full vocabulary semantics (evaluation location is the driver's business; semantics are not)
4. Deterministic sort + pagination
5. Unique index enforcement (duplicate-key errors matching `/duplicate/i`)
6. Insertion-ordered IDs (harness generator, monotonic hex — same as PG)

Optional capabilities: `'transactions'`, `'joins'` — this driver declares NEITHER.

## Package layout

```
workspace/redis-driver/
  package.json          # @coderich/autograph-redis; deps: ioredis, @coderich/util;
                        # devDeps: @coderich/autograph-db-tests, redis-memory-server
  jest.config.js        # mirrors postgres-driver
  jest.setup.js         # beforeAll(setup) / afterAll(disconnect + memory-server stop)
  jest.service.js       # redis-memory-server bootstrap, generator, rawDriver, DDL analog
  src/RedisDriver.js    # the driver
  test/TestSuite.test.js
  test/NOTES.md         # what the exercise proved about the contract (the "what AG is" writeup)
```

Client library: **ioredis** (Lua `defineCommand`, mature). No shim of any kind: `redis-memory-server`
runs a real `redis-server` binary — we test real semantics (fidelity upgrade over pg-mem).

## Storage model

- **Doc**: `SET <model>:<id> <json>` — one JSON blob per document. Embedded docs live inside the
  blob. Dates serialize to ISO strings; revived on read (same move as `PostgresDriver.reviveRow`).
- **Enumeration**: `SADD <model>:__ids <id>` maintained on create/delete. Scans read the set, never
  `SCAN MATCH` (no keyspace-pattern fragility, no collision with index keys).
- **Unique indexes**: `HSET <model>:__unique:<indexName> <valueTuple> <id>` where `valueTuple` is
  the index's field values joined with `\u0000` (a separator that cannot appear in field text — same trick
  PgMemShim uses for its pre-image keys). Index definitions arrive via **constructor
  config** — `new RedisDriver({ uri|client, indexes })` — and the jest harness passes
  `schema.parse().indexes`, exactly mirroring how the PG harness issues `CREATE UNIQUE INDEX`
  from the same data. Uniqueness is a deployment concern; the driver contract stays clean.
- **Null/missing index fields**: entries are only written for tuples where every indexed field is
  non-null (sparse-index behavior — matches how the TestSuite exercises uniqueness).

## Write path — Lua-atomic, honestly non-transactional

All mutations execute as Lua scripts (`defineCommand`) so each WRITE is atomic (Redis is
single-threaded; EVAL is atomic):

- **createOne**: check every unique tuple (`HEXISTS`) → on conflict, error containing
  `duplicate ... "<indexName>"` (TestSuite matches `/duplicate/i`) → `SET` blob + `SADD` id +
  `HSET` index entries, all in one script.
- **updateOne**: driver finds the target via the read path (evaluate `where`, first match),
  merges the flat/dotted `query.input` over the current doc client-side, then one Lua script:
  re-verify unique tuples (allowing self-match), `SET` new blob, diff-update index entries.
  The read→merge→write window is a documented, accepted race — consistent with `supports: []`
  (a store that declares no transactions has consented to exactly this class of anomaly).
- **deleteOne/deleteMany**: resolve target ids via read path → one Lua script per doc: `DEL` blob,
  `SREM` id, `HDEL` index entries.

`transaction()` is NOT implemented. `supports: []` means AG never calls it: scopes are inert for
this source (sessionless writes, durable when awaited, `commit()` no-op, **`rollback()` cannot
undo**). Redis `MULTI/EXEC` cannot support AG's interactive pattern (no read-your-writes before
`EXEC`), so declining the capability is the honest declaration, not a shortcut.

## Read path — the in-driver query engine

`findOne/findMany/count` = `SMEMBERS <model>:__ids` → pipelined `MGET` → parse + revive →
**vocabulary evaluator** → sort → skip/limit (→ `count` = filtered length; `findOne` = first).

The evaluator implements the conformance semantics (PostgresDriver's `applyJsFilters` promoted
from fallback to sole engine):

- Implicit AND across where keys; dotted paths resolve into the doc, INCLUDING through embedded
  arrays (`pins.tag` matches if any pin matches — element-wise descent).
- Operator objects arrive intact: `$eq $ne $gt $gte $lt $lte $in $nin $exists $not $or $and`.
- **Array-field semantics (Mongo reference)**: a scalar/regex predicate against an array field
  matches if ANY element matches; `$in`/`$nin` operands apply element-wise.
- **Portable null rules**: `$ne`/`$nin` also match missing/null; `$exists: true` = a non-null
  value is present; `$not` matches missing/null (Mongo semantics).
- Globs arrive as `RegExp` operands (converted upstream) — bare and inside `$in`/`$nin`.
- Comparisons are type-aware: numbers, strings, Dates/ISO strings (revive-then-compare),
  booleans. `$gt`-family returns false for incomparable/missing operands (Mongo behavior).
- Multi-key sort: type-aware comparator, nulls/missing FIRST ascending, LAST descending
  (Mongo reference); implementation calibrates against the TestSuite's pinned orderings.
- `$or`/`$and` recurse on whole where clauses and coexist with field keys.

Join-shaped queries never reach the driver: no `'joins'` in `supports` means the QueryPlanner
resolves every join-shaped where/sort via its pre-query/`$in` + in-memory-sort pipeline. The
driver never sees `query.joins`.

Evaluator placement: lives inside the driver for now. It is expected to make the case for a
shared `@coderich/autograph-memquery` (or similar) package — but per the workspace's own rule,
extraction waits for the second consumer. `test/NOTES.md` records the observation.

## Contract surface

```js
class RedisDriver {
  constructor({ uri, client, indexes = [] })  // client override for tests; indexes = parsed.indexes
  prepare(query)      // → plan { op, model, where, input, sort, select, skip, limit, first, session? }
                      //   (pure IR shaping; no I/O — mirrors PG's temporal split)
  execute(plan)       // → rows/row/count; runs the read/write paths above
  collection(name)    // raw accessor — required by TestSuite "Bug Fixes"; mirrors Mongo/PG's shape
                      //   (verify exact expectations against TestSuite during implementation)
  disconnect()        // ioredis quit()
  // NO transaction() — supports: [] means AG never calls it
}
```

Discovery points deferred to implementation (resolve by mirroring PostgresDriver and the
TestSuite's actual demands, not by invention): exact `collection()` shape; cursor-pagination
fields (`first`/`before`/`after` — PG treats these as limit/skip shaping above the driver);
`flags({ native })` meaning for a scan engine (expected: no special handling; document it).

## Capability-aware TestSuite (framework deliverable)

Today the TestSuite unconditionally asserts snapshot isolation and rollback-undoes in its
`Transactions (manual)` / `Transactions (manual-with-auto)` sections — both existing drivers
declare `'transactions'`, so it never mattered. This driver forces the conformance suite to
read declared capability:

- `testSuite({ supports = ['transactions', 'joins'] } = {})` — an explicit param in each
  driver's `test/TestSuite.test.js`, defaulting to full capability (existing callers unchanged;
  mongo/pg test files updated to pass theirs explicitly for clarity).
- Sections gate at collection time: with `'transactions'` declared, the current assertions run
  verbatim. WITHOUT it, the sections run the **uncarried-semantics variant** — asserting the
  doctrine rather than skipping: writes through a "txn" are immediately durable/visible,
  `commit()` is a no-op, `rollback()` does NOT undo, and settled-scope stale-write rejection
  still applies (the AG-level scope machinery is real even when the driver never sees a session).
- `'joins'` needs NO gating: join-shaped TestSuite queries pass unchanged through the planner
  fallback (that is the point of it). The `Transactions (auto)` atomicity tests (`*Many`
  rollback-on-partial-failure) DO gate: without driver transactions, a mid-batch failure leaves
  earlier batch writes durable — the variant asserts exactly that.

## Test harness (`jest.service.js`)

- `redis-memory-server` spins a real `redis-server`; ioredis client pointed at it.
- Monotonic-hex ID generator (identical pattern to PG's `jest.service`).
- `global.rawDriver(table)` → `{ findOne, find, findOneAndUpdate }` over the JSON blobs
  (get/scan/patch), mirroring the PG harness's raw accessors.
- Setup passes `dataSource: { supports: [], client }` and `indexes: parsed.indexes` to the
  driver constructor.
- Version/metadata: package version mirrors the ioredis major (workspace convention: PG package
  tracks `pg`'s version); Node engine matches the workspace.

## Out of scope

- Redis Stack (RedisJSON/RediSearch) translation — different driver, different exercise.
- Secondary indexes for query acceleration (sorted-set indexes) — scan-first by design; the
  driver is honest that it's a document substrate for modest collections, not a query engine.
- Cross-key transactional guarantees of any kind (WATCH/optimistic retry) — declined capability.
- Shared in-memory evaluator package extraction — recorded in NOTES.md, waits for consumer #2.

## Success criteria

1. `workspace/redis-driver` passes the full TestSuite with `supports: []` (transaction sections
   in uncarried-variant mode; everything else verbatim, joins included via planner fallback).
2. mongo-driver and postgres-driver suites pass unchanged with explicit `supports` params.
3. Root `npm test` green across all four workspaces; lint clean.
4. `test/NOTES.md` captures the contract findings (what the floor proved, evaluator-extraction
   case, uncarried-semantics observations).
