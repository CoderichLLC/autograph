# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Autograph** is a GraphQL auto-generation library that decorates a GraphQL schema with CRUD resolvers, data pipelines, and event hooks. It follows a schema-first approach where directives (`@model`, `@field`, `@link`) drive code generation.

## Monorepo Structure

npm workspaces under `workspace/`:

| Package | Description |
|---------|-------------|
| `workspace/autograph/` | Core library (`@coderich/autograph`) |
| `workspace/mongo-driver/` | MongoDB adapter (`@coderich/autograph-mongodb`) |
| `workspace/postgres-driver/` | PostgreSQL adapter (`@coderich/autograph-pg`) |
| `workspace/testsuite/` | Shared integration test suite (`@coderich/autograph-db-tests`) |

## Commands

```bash
# Root (all workspaces)
npm test           # Run all workspace tests
npm run lint       # ESLint across all workspaces

# Per workspace (cd into workspace/autograph or workspace/mongo-driver)
npm test           # Jest with --stack-trace-limit=1000
npm run lint       # ESLint (airbnb-base)
npm run dev        # Watch mode via @coderich/dev

# Run a single test file
npx jest path/to/test.test.js

# Run tests matching a pattern
npx jest -t "test name pattern"
```

Node version: 18.12.1 (see `.nvmrc`)

## Architecture

### Core Flow

```
GraphQL Schema (typeDefs with directives)
    → Schema.parse()           # Decorates models/fields with pipeline config
    → Resolver.match(model)    # Returns a QueryResolver builder
    → QueryResolver (fluent)   # .where().select().one()/.many()
    → Pipeline stages          # validate→construct/restruct→instruct→normalize→serialize
    → DataSource driver        # MongoDriver or custom
    → deserialize pipeline     # Transform DB result back
```

### Key Files

- `workspace/autograph/src/schema/Schema.js` — Parses GraphQL SDL, processes directives, merges typeDefs, decorates models. The "big picture" is that `Schema` converts raw GraphQL AST into an internal `$schema` object with pre-computed pipeline functions per field.

- `workspace/autograph/src/data/Resolver.js` — Entry point for all data access. `resolver.match(model)` returns a `QueryResolver`. Manages DataLoaders per model, sets itself at `context.autograph.resolver`, and exposes `.transaction()`/`.commit()`/`.rollback()` (see Transactions).

- `workspace/autograph/src/query/QueryResolver.js` — Fluent builder that accumulates query state then executes via the driver. Extends `QueryBuilder`.

- `workspace/autograph/src/data/Pipeline.js` — Runs field-level transformation stages. Pipelines are arrays of functions that can be sync or async.

- `workspace/autograph/src/data/Emitter.js` — Event system for lifecycle hooks. Listener ROLE is declared at registration, never inferred from arity, via exactly two methods: `on(filter, fn)` registers PARTICIPANTS (awaited, ambient resolver, throw aborts, non-undefined return short-circuits — sync returns stop later initiation; the legacy `(event, next)` done-callback form is honored as a call convention only); `observe(filter, fn)` registers OBSERVERS (fire-and-forget, detached resolver, failures isolated, returns ignored, initiated first). `filter` is an event name (shorthand for `{ event: name }`) or a `{ event, model, crud, priority, once, memoize }` bag — `event` required, everything else optional, values scalar-or-array; both methods return an idempotent disposer that unregisters the whole registration. `hasListenersFor(event, model)` is the fast-path guard (no `key` param). One flat priority order per role.

- `workspace/autograph/src/query/Query.js` — Core query representation. Holds the canonical query state, implements the `.merged` read-only proxy (input overlaid on doc), computes the DataLoader cache key, and provides `.toDriver()` for driver consumption.

- `workspace/autograph/src/data/DataLoader.js` — Smart batch merging. Groups queries by structural fingerprint (op, sort, limit, skip, select), finds clusters that differ in exactly one where-key, and collapses them into a single `$in` driver call chunked at 500.

- `workspace/autograph/src/data/TransactionScope.js` — Identity-based per-data-source transaction bookkeeping (session map, per-session serialization queue, settle-state, cache-invalidation thunk routing). There is no ambient-context mechanism (`AsyncLocalStorage` was tried and removed) — scopes propagate by explicit reference-threading through the resolver you hold. `TransactionScope.run(session, fn)` is the static front door that serializes **every** physical driver call (reads and writes) carrying a session. See Transactions.

- `workspace/mongo-driver/src/MongoDriver.js` — MongoDB 6.x driver adapter. Uses aggregation pipelines for all queries (including finds). Supports `$lookup` joins for populated fields.

### Pipeline Stages (per operation)

- **Create:** `validate → construct → instruct → normalize → serialize`
- **Update:** `validate → restruct → instruct → normalize → serialize`
- **Read result:** `deserialize`

Stage definitions come from `@field()` directives: `@field(construct: "createdAt", serialize: "toObjectId")`.

### Schema Directives

```graphql
type Person @model {
  id: ID @field(key: true)
  name: String @field(normalize: "toLowerCase")
  books: [Book] @link(by: "author")
}
```

- `@model` — Marks a type as a managed entity; `@model(source: "myDataSource")` targets a named driver
- `@field(...)` — Pipeline stage assignments, validation, casting
- `@link(by: "fieldName")` — Relationship definition (foreign key)

### DataLoader / Caching

Every model gets a `DataLoader` instance on the `Resolver`. Results are cached for the lifetime of the resolver instance. Call `resolver.clear(model)` or `resolver.clearAll()` to invalidate.

The DataLoader caches the **raw driver result**, not the transformed output — transformation
(deserialize, docTransform, `$`-magic Doc wrapping, selection shaping) runs PER CALL with the
CALLING resolver and the calling query's `info`. Consequences: every cache hit returns fresh
instances (safe to mutate, spread, and `JSON.stringify` — array fields are shallow-copied out of
the raw row), each call site gets its own selection shaping, and a doc's `$` magic is bound to
the resolver that read it (a doc read through a txn clone writes through the txn clone).

### Where Vocabulary

The `$`-operator syntax in `.where()` is **autograph's own query IR** (deliberately borrowing
MongoDB's proven wire syntax), spec'd in `workspace/autograph/src/query/Vocabulary.js` and
enforced by a per-driver conformance section in the TestSuite. MongoDriver implements it mostly
by passthrough (the reference implementation); every other driver translates to its own idiom.

| Operator | Coercion | Meaning |
|---|---|---|
| `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` | value | operand is field-shaped: pipelines + glob conversion apply exactly as to an equality operand |
| `$in` `$nin` | list | array of field-shaped operands, applied element-wise |
| `$exists` | none | boolean; "a NON-NULL value is present" (portable — Mongo translates to a null-comparison) |
| `$not` | nested | field-level negation; operand is itself an operator object; matches missing/null values (Mongo semantics) |
| `$or` `$and` | compound | arrays of whole where clauses; nest recursively; coexist with field keys (implicit AND) |

Rules and guarantees:
- **Validated at the query boundary** (`Vocabulary.validate`): unknown `$`-operators reject
  loudly — the generated GraphQL where-inputs are `AutoGraphMixed`, so the whole vocabulary is
  available to GraphQL callers and the allowlist is the injection guard.
- Operators are always **terminal**: nest fields-then-operator (`{ sections: { name: { $eq: x } } }`);
  operators never wrap paths. Field pipelines (normalize/serialize/cast) and domain→data key
  mapping run at every depth, INTO operator operands, per the coercion classes.
- `$ne`/`$nin` also match missing/null values (portable Mongo semantics, both drivers).
- **Globs** are the pattern spelling for the transformed path (they ride pipelines as strings,
  then convert glob→regex) — bare and inside `$in`/`$nin` operands. Raw `RegExp` values get
  string-mangled by `$cast` on the transformed path; they belong to `flags({ native })` mode.
- `flags({ native: true | ['where','save','sort'] })` is TRUE driver dialect: it sheds the
  schema's transforms (pipelines, key mapping, finalize) AND the vocabulary contract — raw
  column keys, raw driver constructs (e.g. Mongo `$expr`), unvalidated and untranslated. The
  full resolve() machinery still applies (transactions, DataLoader caching, deserialize, events)
  — native changes what the driver RECEIVES, never how the query participates.
- Limitations (loud, not silent): join paths inside `$or`/`$and` branches are rejected;
  PG does not yet support operators on embedded-ARRAY element paths (its JS-filter fallback) or
  JS-filter-needing predicates inside compound branches.
- DataLoader batch-merging only ever widens equality-shaped values — operator-valued and
  compound keys never become fanout keys.

### Emitter Events

Full event lifecycle per request:

```
preQuery / preMutation → validate → postQuery / postMutation → preResponse → postResponse
                                       ⋯ transaction truly settles ⋯ → postCommit | postRollback
```

```js
emitter.on('setup', (parsedSchema) => { ... });
emitter.on('preQuery',    ({ schema, context, resolver, query }) => { ... });
emitter.on('postQuery',   ({ schema, context, resolver, query }) => { ... });
emitter.on('preMutation', ({ schema, context, resolver, query }) => { ... });
emitter.on('postMutation',({ schema, context, resolver, query }) => { ... });
emitter.on('validate',    ({ schema, context, resolver, query }) => { ... });
emitter.on('preResponse', ({ schema, context, resolver, query }) => { ... });
emitter.on('postResponse',({ schema, context, resolver, query }) => { ... });
emitter.on('postCommit',  ({ schema, context, resolver, query }) => { ... }); // mutations only
emitter.on('postRollback',({ schema, context, resolver, query }) => { ... }); // mutations only
```

**`postCommit` / `postRollback` — the durable-outcome events.** `pre/postMutation` bracket the
*write* (both run inside any ambient transaction and share its fate); `postCommit`/`postRollback`
bracket the *transaction*. `postCommit` fires once per mutation when its write is truly durable —
after the carrying transaction's real commit (a `*Many`/RI wrap's own commit, or the gqlMutation
field scope's commit — per field, or at the hoisted operation's single commit under `@transaction`), or immediately after the
`postResponse` phase for a write no transaction carried. `postRollback` is the compensation hook —
the write succeeded but was then undone by its transaction rolling back. Use `postMutation` for
anything that must share the mutation's fate (atomic follow-up writes via `event.resolver`,
shaping `query.result`) or complete before the response; use `postCommit` only for irreversible
external side effects (email, webhooks, queue publishes). Fire-and-forget semantics: they cannot
shape the response, listener failures are isolated (never rejecting `commit()` or the mutation),
and writes from inside them are new units of work: an arity<2 listener's `event.resolver` is
detached (see below) so its writes just work; an arity>=2 listener under a carried scope holds
the now-settled ambient resolver — start a fresh unit with `event.resolver.transaction()` there.

**The events sort into three layers** (see TRANSACTIONS.md §4.15/§4.16). *DB layer*:
`preMutation`/`validate` shape what lands in the database; `postMutation` participates in the
unit of work. *Response layer*: `preResponse` shapes what the caller is told (last chance to
reshape the outgoing result; skipped if `postMutation` short-circuited); `postResponse` observes
it — it fires **unconditionally**, last, with the settled result, and is a **pure observer**: its
return value is ignored (treat `event.query.result` as read-only there; it does not fire on error
paths). *Durability layer*: `postCommit`/`postRollback` observe what became durably true.

**Failure semantics are role-graded.** `preMutation`/`validate` failures abort the write
(`PreOperationError`). A `postMutation` failure — a *participant* failure — **aborts the whole
transaction** when one carries the write (a plain `throw` is the abort signal, same as every DB
trigger/ORM convention; opt into tolerance with your own `try/catch`); when nothing carries the
write it is already durable, and the failure surfaces as `PostOperationError` with `.result`
(via GraphQL this uncarried branch is rare — every gqlMutation is carried by its field scope;
it mainly applies to direct agMutations in scripts/REPLs/background jobs).
`preResponse`/`postResponse` failures — response-layer failures — are always `PostOperationError`
(data committed, only response work failed; never rollback-worthy). `postCommit`/`postRollback`
failures are isolated and cannot affect anything.
Note: **basic** (arity < 2) listeners are fire-and-forget observers on every event — their async
rejections are deterministically swallowed (never an unhandled rejection), and they receive a
**detached resolver** in `event.resolver` (no transaction scope, ever: reads see committed state
only; writes land immediately and survive any ambient rollback — see TRANSACTIONS.md §4.18). The
unit of work is exactly what the mutation awaits: use the next-style (arity ≥ 2) form when a
hook's failure must mean something or its writes must share the mutation's fate.
Inside a hook, ALWAYS use `event.resolver` — `event.context[namespace].resolver` is **poisoned**
(throws on access): the context slot is the transport's time-sensitive handle (the operation-scope
wrapper swaps it per field), not the hook's; every hook intent has a first-class expression on
`event.resolver` (itself, `.detach()`, `.transaction()`). Every other context property reads and
writes straight through; `event.resolver.getContext()` reaches the real context object.

`query` is the single source of truth. Key properties:

| Property | Description |
|---|---|
| `query.model` | Model name string |
| `query.crud` | `'create'` \| `'read'` \| `'update'` \| `'delete'` |
| `query.input` | Proxy — write to re-run pipelines; read for caller-provided values |
| `query.doc` | Pre-image doc (undefined on create, populated on update/delete) |
| `query.merged` | Read-only deep merge of `input` over `doc` |
| `query.result` | Query result (populated after driver call; writable in `post*` hooks) |
| `query.args` | Raw GraphQL args |
| `query.id` \| `query.key` \| `query.sort` | As named |

`setup` receives the parsed schema POJO `{ models, enums, scalars, indexes, namespace, getModel }`, not the `Schema` class instance.

## Testing

Tests live in `workspace/autograph/test/` and driver packages. The shared `@coderich/autograph-db-tests` package (`workspace/testsuite/`) provides `TestSuite.js` — a comprehensive integration suite run by each driver package against an in-memory database.

Test setup files (autograph workspace):
- `jest.prepare.js` — Early bootstrap
- `jest.setup.js` — Extended Jest matchers (`.thunk()`, `.multiplex()`)
- `jest.service.js` — Starts `mongodb-memory-server`

Files ending in `.testSKIP.js` or `.testNotYet.js` are intentionally excluded from the test run.

## Writing a Driver

A driver is a class with two required methods (`prepare` and `execute`) plus several methods used directly by the TestSuite. Every driver workspace follows the same structure as `workspace/mongo-driver/` or `workspace/postgres-driver/`.

### Driver Contract

```js
class MyDriver {
  // Convert an autograph query descriptor into an opaque plan object.
  // The plan is passed unchanged to execute().
  prepare(query) { ... }

  // Execute a previously-prepared plan and return results.
  execute(plan) { ... }

  // There is NO production raw accessor: native expressiveness lives INSIDE the QueryBuilder —
  // the Where Vocabulary (below) plus `flags({ native })` cover it, inheriting transactions,
  // caching, and events for free. The TestSuite's raw-row verification uses a TEST-HARNESS
  // accessor (`global.rawDriver(tableKey)` → { findOne, find, findOneAndUpdate }) defined in
  // each driver package's jest.service — a test concern, not part of this contract.

  // Required by TestSuite "Bug Fixes" section.
  // Returns a raw collection accessor.
  collection(name) {
    return { query(...args) };  // raw query execution
  }

  disconnect() { ... }   // called in afterAll

  // Required only if dataSource.supports includes 'transactions'.
  // Called with no argument to open a brand-new top-level transaction: must return
  // { session, commit(), rollback() } (session is forwarded to every plan via query.options.session).
  // Called WITH a parentSession when TransactionScope is joining an already-ambient transaction —
  // if your driver can't nest (e.g. MongoDB: a session supports exactly one active transaction),
  // return parentSession unchanged; TransactionScope detects that identity and treats it as a
  // COUPLED/shared-fate relationship (rollback propagates to whoever owns the real session; commit
  // is a no-op there). A driver that DOES support real nested transactions returns a DISTINCT
  // handle — TransactionScope classifies it NESTED: rollback is real and PARTIAL (undoes only the
  // child's work; the parent survives), while commit merely folds the work into the parent's fate
  // (settled callbacks — postCommit etc. — are handed up and fire at the true owner's seal).
  // PostgresDriver implements this via SAVEPOINT/RELEASE/ROLLBACK TO (savepoints nest natively);
  // because savepoints are a LINEAR STACK per connection, it serializes SIBLING savepoint
  // lifetimes through a per-handle gate (nested chains unaffected — no deadlock). On Postgres
  // this is also what un-poisons an aborted transaction (25P02) after a failed nested write, so
  // catch-and-continue tolerance inside a participant hook actually works.
  transaction(parentSession) { ... }
}
```

### What `prepare(query)` receives

| Field | Description |
|---|---|
| `query.op` | `'findOne'` \| `'findMany'` \| `'count'` \| `'createOne'` \| `'updateOne'` \| `'deleteOne'` \| `'deleteMany'` |
| `query.model` | Table/collection name string |
| `query.where` | Flat object: dotted keys are field PATHS only; **vocabulary operator objects arrive INTACT** — `{ price: { $ne: -999 } }` arrives exactly as written (never flattened into `'price.$ne'`), and compound operators (`$or`/`$and`) arrive as arrays of where clauses. See Where Vocabulary. |
| `query.input` | Mutation payload (also flat/dot-notated for nested fields) |
| `query.sort` | Flat sort object, e.g. `{ name: 'asc' }` |
| `query.select` | Array of column/field name strings |
| `query.joins` | Array of join descriptors for populated fields |
| `query.$schema` | `fn(modelFieldPath) → fieldMeta` — returns field metadata (`isArray`, `isEmbedded`, `type`, `key`, `isPrimaryKey`, `isVirtual`, ...) |
| `query.options?.session` | Transaction session object; only present when `dataSource.supports` includes `'transactions'` and a transaction is active |

### Transactions

Two independent mechanisms, both built on `TransactionScope`:

- **Manual** — `resolver.transaction({ isolated = true, coupled = true })` / `.commit()` / `.rollback()`. An explicit "break out into my own transaction" demarcation. `isolated` clones the resolver (its own DataLoader cache); `coupled` (default) offers whatever's currently ambient to the driver as a parent and accepts whatever relationship comes back — the driver decides: MongoDB hands the parent handle back (COUPLED — shared fate; a child rollback aborts the whole unit), PostgresDriver opens a SAVEPOINT and hands back a distinct handle (NESTED — child rollback is real and partial, the parent survives; child commit defers durability to the parent, so `postCommit` waits for the true seal). Pass `coupled: false` to force a wholly independent transaction regardless of driver capability.
- **Automatic, always-on** — RI cascades (`onDelete: cascade/nullify/restrict`) and `*Many` batch ops (`createMany`/`updateMany`/`pushMany`/`pullMany`/`spliceMany`/`deleteMany`) are unconditionally wrapped in their own scope in `QueryResolver.js` (via `resolver.withTransaction()` — the same public API a manual caller uses), regardless of the flag below — autograph is both the opener and definitive closer of these bounded operations, so no external signal is needed.
- **Automatic, per-gqlMutation** — every root Mutation field (gqlMutation) is its own unit of work: `Schema#toObject()` wraps every root Mutation resolver (user-defined included, since user precedence is applied inside AG's resolver merge — see `OperationScope.js`) to run the field through `withTransaction()` against an isolated clone, swapping `context[namespace].resolver` to the clone for the duration (root mutation fields are spec-serial, so assign+restore is race-free). The field's write and its participant (postMutation) hooks share one transaction — a participant throw rolls the write back; commit lands before the field resolves. The caller-facing partial-success contract across fields is unchanged. agMutations (`resolver.match().save()` etc.) only ever JOIN an ambient scope, never create one. Annotating the operation `mutation @transaction { a, b, c }` (directive declared in framework typeDefs; name configurable) **escalates the unit of work from field to operation — the operation executes as if it were a single resolver**: the FIRST live root field's invocation HOISTS the entire unit, executing every live root selection sequentially (real resolver fns; args coerced from the document AST via graphql's `getArgumentValues`; faithful sibling `info`s; same-key selections deduped exactly like executor field merging) against one shared clone, then settles the transaction BEFORE returning anything — subsequent field invocations are replay stubs (recorded result, or recorded error at their own path). Because the unit's fate is sealed before any field materializes into `data`, `data` can never exhibit a rolled-back payload — regardless of field nullability (no designated committer, no settle-state short-circuit, no non-null interplay, no nullability restriction). A mid-operation response-layer (`PostOperationError`) failure no longer aborts: the hoist completes the unit and commits. **The response contract** (TRANSACTIONS.md §4.17): every wrapper-thrown error carries `extensions.{code, committed}` — `code` classifies the phase (`PRE_OPERATION_ERROR`/`POST_OPERATION_ERROR`/`MUTATION_ERROR`/`OPERATION_ABORTED`), `committed` is the unit's durable fate. Deliberately NO `result` extension — response payloads only flow through GraphQL completion (selection sets, custom resolvers, crud visibility); a committed-but-response-layer-failed field is `null` in `data` with `committed: true` on its error (refetchable). The invariant, no scenario-dependent readings: a populated `data` field is ALWAYS a real committed result. Hoist caveats: tracing attributes the unit's work to the first field; a non-null rollback surfaces at the FIRST field's path (cause embedded); schema-less direct invocations can't hoist and degrade to per-field units; `getArgumentValues` is graphql-realm-sensitive (dual-package hosts fail loud — rollback — never miscoerce); a live root field whose resolver wasn't wrapped by `toObject()` (merged out-of-band) fails the unit loudly (`OPERATION_ABORTED`, before any transaction opens) — never silently excluded. An already-open host scope makes the wrapper stand down. The request resolver is never scoped in place by autograph; a host that assembles its own executable schema scopes it itself with `transaction({ isolated: false })` and owns `commit()`/`rollback()` (TRANSACTIONS.md §4.4/§4.7). There is no `autoTransaction` flag or `enableAutoTransaction()` anymore, no lazy scopes (every scope binds a session on first use, read or write), and no timing-heuristic auto-commit anywhere.

A scope only actually calls `client.transaction()` for data sources whose `supports` array includes `'transactions'` — sources that don't participate run exactly as if no scope existed: writes dispatch sessionless (durable when awaited, uncarried semantics), `commit()` is a no-op, and **`rollback()` cannot undo** — declaring no support is consenting to that. `supports` is consumer-declared (never probed — the consumer knows both driver and deployment) and defaults to `[]`. The same doctrine covers `'joins'`: absent, QueryPlanner resolves every join-shaped where/sort (pre-query → `$in`; in-memory joined sort) and the driver never receives `query.joins`. See `TransactionScope.js` for the identity-based coupled/nested/independent mechanism.

### ObjectId shim (non-MongoDB drivers)

The TestSuite uses `global.ObjectId`, `expect.any(ObjectId)`, `ObjectId.isValid()`, and `new ObjectId(id)`. Non-MongoDB drivers should use the provided shim instead of the real MongoDB ObjectId:

```js
const { createObjectIdShim } = require('@coderich/autograph-db-tests');
global.ObjectId = createObjectIdShim();
```

IDs remain plain strings everywhere. `Symbol.hasInstance` is overridden so that any non-empty string satisfies `instanceof ObjectId`, making `expect.any(ObjectId)` pass without wrapping IDs in ObjectId instances.

### ID generation and sort order

The TestSuite implicitly relies on IDs sorting in insertion order (e.g. multi-result assertions compare results in creation order). MongoDB ObjectIds are time-ordered, so this holds naturally. Non-MongoDB drivers **must generate IDs that sort lexicographically in creation order** — random UUIDs will cause intermittent ordering failures. A monotonically-increasing counter formatted as a fixed-width hex string works well:

```js
let seq = 0;
function nextId() {
  const hex = (++seq).toString(16).padStart(32, '0');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
```

## Known Issues (from `workspace/autograph/notes`)

- Not all mutations go through `$aggregateQuery` in MongoDriver (loses `$project`)
- `debug` flag is not always propagated through `findMany`, `pullMany`, etc.
- ~~`Resolver` gives no explicit "settled" state after `.commit()`/`.rollback()`~~ — fixed:
  `TransactionScope` now tracks `state` (`open`/`committed`/`rolledBack`); commit/rollback are
  idempotent (memoized), a stale **write** against a settled scope rejects with a clear AG-level
  error, and a **read** through a settled scope degrades to a plain sessionless read of committed
  state (needed because docs returned from a transaction lazily resolve populated fields through
  the same, now-settled resolver during response serialization).
- ~~`.where({ field: { $in: [...] } })` reads return nothing~~ — **fixed**, and generalized: the
  root cause (`Query.js#finalize` flattening operator objects into `'field.$in'`-style keys that
  MongoDB treats as literal field paths matching nothing) affected EVERY operator through the
  normal path. `#finalize` now flattens field paths only — operator objects reach drivers intact
  — and the operator set is a first-class, validated **vocabulary** (`src/query/Vocabulary.js`):
  `$eq/$ne/$in/$nin/$gt/$gte/$lt/$lte/$exists/$not` plus compound `$or/$and` work through
  `.where()` (and the GraphQL Mixed where-inputs) with field pipelines applied to operator
  operands, an allowlist rejecting unknown operators loudly (closing a latent injection surface),
  DataLoader merge-safety, and a per-driver conformance section in the TestSuite. See the Where
  Vocabulary section.

## Release 0.16 Goals

- ~~Re-introduce transactions with explicit `TransactionScope`~~ — done (`TransactionScope.js`);
  see Transactions above.
- `createMany`/`updateMany` as true driver-level batch operations (not N serial `createOne` calls)
  — still N serial calls today, just now atomically wrapped, not batched at the driver level.
- ~~Enforce `dataSources.supports` capability flags~~ — done, as HONOR-not-enforce: `supports` is consumer-declared (they know driver AND deployment; absent = `[]`); no `'transactions'` → scopes are inert for the source (sessionless writes, uncarried semantics — `rollback()` cannot undo); no `'joins'` → QueryPlanner resolves join-shaped where/sort via its pre-query/`$in` + in-memory-sort pipeline (drivers never see `query.joins`; correctness-first, not perf-neutral; WHERE lifts cover FK sub-paths, embedded-prefix stored FKs, and bare virtual equality — the loud edges are join-shaped SORT deeper than a first-segment FK and WHERE on a virtual link behind an embedded prefix). `batches`/`referentialIntegrity` flags dropped (were declared/read nowhere). See `SupportsFallback.test.js`.
- Route all MongoDriver mutations through `$aggregateQuery` so `$project` applies consistently
- Fix `query.flags.debug` propagation (currently missing from cache hits and recursive mutation paths)
- Embedded document pipeline events (`construct: 'createdBy'` etc. currently don't fire for embeds)
- Rename `$field.fkField` → `$field.joinKey` for clarity (both `linkBy` and `fkField` default to `linkTo.pkField` but serve different purposes — `linkBy` is for virtual/reverse joins; `fkField`/`joinKey` is for persisted FK fields)
- Tests overhaul: Scalar `@field()` coverage still open. ~~Re-enable/expand transaction test
  coverage~~ — done (manual, coupled vs. independent, RI/`*Many` atomicity, sibling-hook race,
  settle-state, operation scope, detached resolvers; see `TransactionScope.test.js`,
  `Resolver.test.js`, `OperationScope.test.js`, and the TestSuite "Transactions (auto)" section)
