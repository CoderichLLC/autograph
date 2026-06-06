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

- `workspace/autograph/src/data/Resolver.js` — Entry point for all data access. `resolver.match(model)` returns a `QueryResolver`. Manages DataLoaders per model, transaction sessions, and sets itself at `context.autograph.resolver`.

- `workspace/autograph/src/query/QueryResolver.js` — Fluent builder that accumulates query state then executes via the driver. Extends `QueryBuilder`.

- `workspace/autograph/src/data/Pipeline.js` — Runs field-level transformation stages. Pipelines are arrays of functions that can be sync or async.

- `workspace/autograph/src/data/Emitter.js` — Event system for lifecycle hooks. "Basic" functions (arity < 2) execute first and can short-circuit; "next" functions (arity ≥ 2) form a middleware chain.

- `workspace/autograph/src/query/Query.js` — Core query representation. Holds the canonical query state, implements the `.merged` read-only proxy (input overlaid on doc), computes the DataLoader cache key, and provides `.toDriver()` for driver consumption.

- `workspace/autograph/src/data/DataLoader.js` — Smart batch merging. Groups queries by structural fingerprint (op, sort, limit, skip, select), finds clusters that differ in exactly one where-key, and collapses them into a single `$in` driver call chunked at 500.

- `workspace/autograph/src/data/Transaction.js` — Transaction coordinator across multiple data sources. Currently incomplete — see Known Issues.

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

Tests live in `workspace/autograph/test/` and `workspace/mongo-driver/test/`. The shared `@coderich/autograph-db-tests` package (`workspace/testsuite/`) provides `TestSuite.js` — a comprehensive integration suite run by both packages against a MongoDB memory server.

Test setup files (autograph workspace):
- `jest.prepare.js` — Early bootstrap
- `jest.setup.js` — Extended Jest matchers (`.thunk()`, `.multiplex()`)
- `jest.service.js` — Starts `mongodb-memory-server`

Files ending in `.testSKIP.js` or `.testNotYet.js` are intentionally excluded from the test run.

## Known Issues (from `workspace/autograph/notes`)

- Transactions are currently removed — complex race condition issues
- `$magic` methods have potential race conditions in nested transactions
- Not all mutations go through `$aggregateQuery` in MongoDriver (loses `$project`)
- Failing tests may blow up Jest due to circular references (related to transaction removal)
- `debug` flag is not always propagated through `findMany`, `pullMany`, etc.

## Release 0.15 Goals

- Remove all remaining deprecations (`getModels`/`getModel`, `@field(transform:...)`, legacy `gqlScope`/`dalScope`/`fieldScope` shims, `withResolvers` alias)
- Break up `Schema.js` monolith (1,136 lines → `SchemaParser`, `SchemaApi`, `SchemaDirectives` + thin orchestrator)
- Re-introduce transactions with explicit `TransactionScope` (no implicit session hopping on Resolver)
- `createMany`/`updateMany` as true driver-level batch operations (not N serial `createOne` calls)
- Enforce `dataSources.supports` capability flags (`transactions`, `joins`, `batches`, `referentialIntegrity`)
- Route all MongoDriver mutations through `$aggregateQuery` so `$project` applies consistently
- Fix `query.flags.debug` propagation (currently missing from cache hits and recursive mutation paths)
- Embedded document pipeline events (`construct: 'createdBy'` etc. currently don't fire for embeds)
- Rename `$field.fkField` → `$field.joinKey` for clarity (both `linkBy` and `fkField` default to `linkTo.pkField` but serve different purposes — `linkBy` is for virtual/reverse joins; `fkField`/`joinKey` is for persisted FK fields)
- Tests overhaul: Scalar `@field()` coverage, fix Jest circular-reference crash, re-enable auto-transaction tests
