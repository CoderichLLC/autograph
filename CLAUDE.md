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

- `workspace/autograph/src/data/Emitter.js` — Event system for lifecycle hooks. "Basic" functions (arity < 2) execute first and can short-circuit; "next" functions (arity ≥ 2) form a middleware chain.

- `workspace/autograph/src/query/Query.js` — Core query representation. Holds the canonical query state, implements the `.merged` read-only proxy (input overlaid on doc), computes the DataLoader cache key, and provides `.toDriver()` for driver consumption.

- `workspace/autograph/src/data/DataLoader.js` — Smart batch merging. Groups queries by structural fingerprint (op, sort, limit, skip, select), finds clusters that differ in exactly one where-key, and collapses them into a single `$in` driver call chunked at 500.

- `workspace/autograph/src/data/TransactionScope.js` — Identity-based per-data-source transaction bookkeeping (session map, serialization queue, cache-invalidation thunk routing). `workspace/autograph/src/data/TransactionContext.js` — thin `AsyncLocalStorage` wrapper propagating "the currently ambient scope" to nested/sibling calls. See Transactions.

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

The DataLoader caches the **raw driver result**, not the transformed output — it is safe to mutate, spread, and `JSON.stringify` returned documents.

### Emitter Events

Full event lifecycle per request:

```
preQuery / preMutation → validate → postQuery / postMutation → preResponse → postResponse
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
```

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

  // Required by TestSuite "Driver Queries" section.
  // Returns a raw table/collection accessor that bypasses autograph pipelines.
  driver(name) {
    return {
      findOne(where),           // → Promise<row | null>
      findMany(where),          // → Promise<row[]>
      find(where),              // → Promise<{ toArray() }>   (MongoDB cursor shape)
      findOneAndUpdate(where, update),  // update may be { $set: patch } or plain patch
    };
  }

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
  // coupled/shared-fate relationship (rollback propagates to whoever owns the real session; commit
  // is a no-op there). A driver that DOES support real nested transactions (e.g. Postgres
  // SAVEPOINT) should return a distinct handle instead.
  transaction(parentSession) { ... }
}
```

### What `prepare(query)` receives

| Field | Description |
|---|---|
| `query.op` | `'findOne'` \| `'findMany'` \| `'count'` \| `'createOne'` \| `'updateOne'` \| `'deleteOne'` \| `'deleteMany'` |
| `query.model` | Table/collection name string |
| `query.where` | Flat object. **MongoDB-style operators are pre-flattened by `Util.flatten`** — `{ price: { $ne: -999 } }` arrives as `{ 'price.$ne': -999 }`. Reconstruct before use. |
| `query.input` | Mutation payload (also flat/dot-notated for nested fields) |
| `query.sort` | Flat sort object, e.g. `{ name: 'asc' }` |
| `query.select` | Array of column/field name strings |
| `query.joins` | Array of join descriptors for populated fields |
| `query.$schema` | `fn(modelFieldPath) → fieldMeta` — returns field metadata (`isArray`, `isEmbedded`, `type`, `key`, `isPrimaryKey`, `isVirtual`, ...) |
| `query.options?.session` | Transaction session object; only present when `dataSource.supports` includes `'transactions'` and a transaction is active |

### Transactions

Two independent mechanisms, both built on `TransactionScope`/`TransactionContext`:

- **Manual** — `resolver.transaction({ isolated = true, coupled = true })` / `.commit()` / `.rollback()`. An explicit "break out into my own transaction" demarcation. `isolated` clones the resolver (its own DataLoader cache); `coupled` (default) offers whatever's currently ambient to the driver as a parent and accepts whatever relationship comes back — pass `coupled: false` to force a wholly independent transaction regardless of driver capability.
- **Automatic, always-on** — RI cascades (`onDelete: cascade/nullify/restrict`) and `*Many` batch ops (`createMany`/`updateMany`/`pushMany`/`pullMany`/`spliceMany`/`deleteMany`) are unconditionally wrapped in their own scope in `QueryResolver.js` (`#withTransaction`), regardless of the flag below — autograph is both the opener and definitive closer of these bounded operations, so no external signal is needed.
- **Automatic, opt-in** — `new Resolver({ autoTransaction: true })` gives the resolver its own root scope at construction (cheap — no driver session until the first write). Every operation for that resolver's lifetime (i.e. the whole request, given the one-`Resolver`-per-request convention) shares it once bound. Left opt-in because `Resolver` is also used in contexts with no "end of request" to hook (scripts, admin tools, REPL, background jobs) — the host **must** call `resolver.commit()`/`.rollback()` at a deterministic completion point (e.g. an Apollo Server `willSendResponse`/`didEncounterErrors` plugin) when this is enabled; there is no timing-heuristic auto-commit.

A scope only actually calls `client.transaction()` for data sources whose `supports` array includes `'transactions'` — sources that don't participate run exactly as if no scope existed. See `TransactionScope.js` for the identity-based coupled/independent mechanism.

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
- `Resolver` gives no explicit "settled" state after `.commit()`/`.rollback()` — a stale write
  issued against an already-closed scope fails with a raw driver error (e.g. Mongo "session
  ended") rather than a clear AG-level one. Flagged as a follow-up robustness item, not yet fixed.

## Release 0.16 Goals

- ~~Re-introduce transactions with explicit `TransactionScope`~~ — done (`TransactionScope.js` +
  `TransactionContext.js`); see Transactions above.
- `createMany`/`updateMany` as true driver-level batch operations (not N serial `createOne` calls)
  — still N serial calls today, just now atomically wrapped, not batched at the driver level.
- Enforce `dataSources.supports` capability flags (`transactions`, `joins`, `batches`, `referentialIntegrity`)
- Route all MongoDriver mutations through `$aggregateQuery` so `$project` applies consistently
- Fix `query.flags.debug` propagation (currently missing from cache hits and recursive mutation paths)
- Embedded document pipeline events (`construct: 'createdBy'` etc. currently don't fire for embeds)
- Rename `$field.fkField` → `$field.joinKey` for clarity (both `linkBy` and `fkField` default to `linkTo.pkField` but serve different purposes — `linkBy` is for virtual/reverse joins; `fkField`/`joinKey` is for persisted FK fields)
- Tests overhaul: Scalar `@field()` coverage, re-enable/expand transaction test coverage (manual,
  coupled vs. independent, RI/`*Many` atomicity, sibling-hook race under one scope)
