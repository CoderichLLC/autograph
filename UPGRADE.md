# Upgrading to autograph 0.14

This guide covers every breaking change introduced between `0.12.x` and `0.14.x`. It is the shared reference for the Spitfire migration. Each entry has **What**, **Why**, and **Find** (a grep that locates affected code in a consumer).

> Open questions are collected at the bottom under **Unresolved**. Anything in that section is a place where the author intent is ambiguous and we should decide before the migration is "done."

---

## Why upgrade?

The 0.12 → 0.14 line is primarily a **simplification + performance** release.

- **Read path is ~60% faster on `findMany`.** The Proxy-based, Transformer-driven deserialize was replaced by a per-model compiled `docTransform` plain function. No Proxy traps on hot result paths.
- **Result objects are now plain JS objects, safe to mutate.** DataLoader caches the raw driver result, not the post-transform output, so mutating a result no longer poisons subsequent dataloader hits.
- **One canonical event shape.** All hooks now receive `{ schema, context, resolver, query }`. The legacy spread (`event.merged`, `event.input`, `event.result`, `event.doc`, etc.) is gone. There is one source of truth: `event.query`.
- **Mongo driver extracted into `@coderich/autograph-mongodb`.** Core no longer ships `mongodb` as a dependency. Drivers can be swapped or versioned independently of core.
- **Schema is no longer a monolith.** Construction is a fluent builder (`new Schema(config).framework().merge(...).decorate().api()`), each verb idempotent. The internal `Model`/`Field`/`Type` classes were folded into a parsed POJO so internals are free to change.
- **Listener priority + arity-based execution.** Hooks can declare priority; arity-1 listeners run synchronously up-front (and can short-circuit by returning), arity-2 listeners run as a `next()` middleware chain.
- **Lifecycle ownership clarified.** Index creation and DB disconnect are no longer Schema/Resolver concerns — the consumer owns them.

---

## 1. Architectural change: monorepo split

`@coderich/autograph` is now part of a npm workspaces monorepo with three packages:

| Package | Purpose |
|---|---|
| `@coderich/autograph` | Core schema engine, resolver, pipeline, emitter |
| `@coderich/autograph-mongodb` | MongoDB 6.x driver (was bundled inline as `src/driver/MongoDriver.js` in 0.12) |
| `@coderich/autograph-db-tests` | Shared driver-conformance test suite (dev-only, not consumer-facing) |

**Consumer impact:** add `@coderich/autograph-mongodb` to your `dependencies`; the driver is no longer transitively available.

---

## 2. Bootstrap & wiring

### 2a. Schema construction

**Before (0.12):**
```js
const { Schema, Resolver, Driver } = require('@coderich/autograph');

const stores = {
  default: {
    Driver: new Driver('Mongo'),
    uri: 'mongodb://localhost/db',
    options: { tlsInsecure: true },
    directives: { version: 4 },
  },
};

const schema = new Schema(typeDefs, stores).decorate();
const resolver = new Resolver(schema, context);
context.autograph = { resolver };
```

**After (0.14):**
```js
const { Schema, Resolver } = require('@coderich/autograph');
const MongoClient = require('@coderich/autograph-mongodb');

const config = {
  namespace: 'autograph',
  generators:  { default: ({ value }) => new ObjectId(value) },
  dataLoaders: { default: { cache: true } },
  dataSources: { default: { supports: [], client: new MongoClient({ uri, options }) } },
  decorators:  { default: `type default { id: ID! @field(key: "_id") createdAt: Date @field(serialize: createdAt, crud: r) }` },
};

const schema = new Schema(config)
  .framework()                               // (re)inject @model/@field/@link/@index directives
  .merge({ typeDefs, resolvers })            // ingest SDL — accepts string | AST | Schema | { typeDefs, resolvers }
  .decorate()                                // apply config.decorators[<value>] to each @model(decorate: ...)
  .api();                                    // generate Query/Mutation/Subscription typeDefs + resolvers

const resolver = new Resolver({ schema, context });
// Resolver auto-mounts at context[namespace].resolver — no manual context.autograph = ... needed
```

**Why:** Three reasons converge.
- The `Schema` constructor no longer takes typeDefs. Config (namespace, generators, data sources, decorators) goes in the constructor; SDL goes in `.merge()`. This makes typeDefs composable across modules and removes the constructor's side-effecty `decorate()` step.
- Drivers are no longer bundled. `new Driver('Mongo')` is gone — you wire a client into `dataSources.<name>.client` and the model's `@model(source: ...)` arg picks the source by name.
- The Resolver constructor takes an options bag (`{ schema, xschema, context }`) so future additions are non-breaking. It also auto-mounts itself in `context[namespace].resolver`, removing manual context wiring.

**Find:**
```sh
grep -rn "new Driver\|require('@coderich/autograph')" src/
grep -rn "new Resolver([^{]" src/
grep -rn "context\.autograph\s*=" src/
```

### 2b. Fluent Schema builder verbs

Available verbs in order: `framework() → merge(input) → decorate() → api() → makeExecutableSchema() → toObject() → parse() → setup()`.

- `parse()` returns the `$schema` POJO (lazy; called by Resolver and by `setup()`).
- `setup()` emits `'setup'` with the parsed schema. **It no longer creates indexes**; the consumer owns index creation. See §6 (Emitter) for the new setup payload shape.

**Find:**
```sh
grep -rn "schema\.\(initialize\|finalize\|getModels\|getModel\)" src/
```

### 2c. Index creation moved to consumer

In 0.12, `schema.setup()` walked `model.getIndexes()` and called the driver's `createIndexes(key, indexes)`. In 0.14, `setup()` only emits the `'setup'` event with `{ models, enums, scalars, indexes, namespace, getModel }`. Consumers must walk `parsedSchema.indexes` and call the driver's index API themselves (e.g. `mongoClient.collection(key).createIndex(spec, options)` for the Mongo driver).

**Why:** With the driver split, core can't assume the existence of any specific index API. Spitfire is already consumer-owned for indexes — it manages them via `migrations/`, has zero `@index` directives in module schemas, and never calls `schema.setup()` for index purposes. So no migration work needed for this contract specifically; just be aware the core no longer auto-creates indexes if you ever start using the `@index` directive again.

**Find:**
```sh
grep -rn "schema\.setup\|getIndexes\b" src/
```

---

## 3. Directives & pipeline stages

### 3a. `@field(transform: ...)` → `@field(normalize: ...)`

`transform` was overloaded; `normalize` describes the stage's actual job (canonicalize input). The old `transform:` arg is silently mapped to `normalize:` for backwards-compat in this release, but should be migrated.

**Find:**
```sh
grep -rEn "@field\([^)]*transform:" src/ migrations/
```

### 3b. `gqlScope` / `dalScope` / `fieldScope` → `crud` + `scope`

The triad collapsed into:
- `crud: "crud"` — letters specify which auto-generated API methods are exposed (`c`reate / `r`ead / `u`pdate / `d`elete).
- `scope: ...` — controls how a field can reference its model.

The old args are still honored as backwards-compat shims in `Schema.js` but are deprecated. Migrate to keep things readable.

**Find:**
```sh
grep -rEn '\b(gqlScope|dalScope|fieldScope|authz):' src/ migrations/
```

### 3c. Pipeline stage `transform` and `destruct` removed; `toId` removed

- The `transform` and `destruct` pipeline stages no longer exist.
- The pre-defined `toId` pipeline is gone. **Migration path: replace with `$fk`** for foreign-key/primary-key fields. For most cases you don't need to write `serialize: "$fk"` explicitly — `$fk` is auto-prepended to the serialize pipeline whenever the schema can resolve `isFKReference || isPrimaryKey` for the field (`Schema.js:539`). For corner cases where the field's type doesn't resolve to a model (e.g. a union-typed field that stores an ID), use `serialize: "$fk"` explicitly — `$fk` falls back to the field's own generator, which by default is the source's ID generator. **Quoting note:** in GraphQL SDL, write it as a string literal — `serialize: "$fk"` — because `$` isn't a valid bare identifier in GraphQL. The schema parser will reject `serialize: $fk` (unquoted) at parse time.
- A new stage `deserialize` is available (read path) — an explicit hook to transform driver-shaped values back into application shape, replacing the `transform` Proxy traps.

**Why:** `toId` was Mongo-specific and hard-coded into core; that's wrong now that the driver is a separate package. `$fk` replaces it cleanly because (a) it's driver-agnostic — the actual ID minting comes from the consumer-supplied `generators.default` in the Schema config; (b) it's smarter — for FK fields it pulls from the linked model's PK generator so cross-source references work. Removing `transform`/`destruct` simplifies the pipeline model down to: write path = `validate → construct/restruct → instruct → normalize → serialize`, read path = `deserialize`.

**Find:**
```sh
grep -rEn "\btoId\b|@field\([^)]*\b(transform|destruct):" src/ migrations/
```

### 3d. New `@model` args: `source` and `decorate`

- `@model(source: "default")` — selects the data source from `config.dataSources`. Replaces 0.12's `driver: "..."` arg (which is still accepted as a transitional alias).
- `@model(decorate: "default")` — selects the SDL template from `config.decorators` to merge into this type. Replaces ad-hoc inheritance/composition patterns.

### 3e. Write-path pipeline stages receive the *clean input*, not a doc-merged view

**What:** On a mutation, each write-path stage (`cast → normalize → instruct → construct/restruct → serialize`) is now invoked with the field's value taken from the **caller's input for this mutation only**. The thunk args are `{ startValue, value, query, resolver, context, model, field }`:
- `value` — the field's value flowing through *this* input (first stage: `value === startValue`, the input value for the key; later stages: the prior stage's output). **It is the input value, not the persisted value.**
- On a *partial update* that omits the field, `value` is `undefined`.
- The persisted pre-image is `query.doc` (present on update/delete, `undefined` on create). **This is the "existing value."**

In 0.12 the transformer shaped a doc-merged object, so for an omitted field `value` was effectively the *existing* value. In 0.14 the create/update transformer runs over clean input (see §6b), so omitted fields arrive as `undefined`.

**Why this bites:** a custom stage written as `value || <derive-from-context>` (or `value ?? …`) to mean *"keep the existing value, else default"* silently changed behavior on **update**. Because `value` is now `undefined` for any field the caller didn't supply, and because `instruct` runs on **both** create and update, the stage falls through to the context-derived default and **overwrites the stored value** on every update — even when the mutation never mentioned that field.

It stays invisible until the field's correct value differs from the context default. (A `network` field instructed from `context.network.id` never differs from the record's network, so its re-derivation is a harmless no-op — and `validate: immutable` would catch a genuine mismatch. A `workspaces` field instructed from `context.workspace.id` *does* differ — e.g. a live record edited from the draft view — so it gets clobbered to the selected workspace.) Single-context test harnesses won't catch it either, since input and doc share one workspace.

**Migration:**
- To preserve an existing value on partial update, read it from the pre-image — `value || query?.doc?.<field> || <default>` — do **not** rely on `value`.
- Scope create-only population to `construct`, update-only to `restruct`. Reserve `instruct` for values meant to be (re)derived on *every* write.
- Pair context-derived identity fields with `validate: immutable` so a genuine mismatch throws instead of silently writing.

**Find:**
```sh
# custom pipelines that default from context but may ignore the existing doc value
grep -rEn "Pipeline\.define\(" src/ | grep -E "context\.|requestInfo"
# fields whose instruct/restruct stage runs on update
grep -rEn "@field\([^)]*\b(instruct|restruct):" src/
```

---

## 4. Resolver API

### 4a. Constructor signature

**Before:** `new Resolver(schema, context)`
**After:**  `new Resolver({ schema, xschema, context })`

`xschema` is the executable `GraphQLSchema` (the result of `makeExecutableSchema`). It's optional; if provided, `resolver.graphql({ source, variableValues })` can run a query in-process with `contextValue` defaulted to the resolver's context. **Note:** the `xschema` + `resolver.graphql()` story is useful but not yet fully baked — treat it as available-but-experimental. Don't build load-bearing logic on it without confirming the API has stabilized.

### 4b. `resolver.disconnect(model)` removed

**Before:**
```js
await resolver.disconnect('NetworkPlace');
```
**After:**
```js
await mongoClient.disconnect();   // or schema config's dataSource.client.disconnect()
```

**Why:** The Resolver no longer owns driver lifecycle. With the driver split, the consumer instantiated the client, so the consumer disconnects it.

**Find:**
```sh
grep -rEn "resolver\.disconnect" src/
```

### 4c. Transactions are essentially removed

The old `resolver.transaction(parent)` returning a `QueryBuilderTransaction` with `.run()` is gone. `Resolver.transaction()` exists in 0.14 but **the notes file flags transactions as a known issue** ("currently removed — very tricky to get right; MutateMany should NOT be a transaction of multiple MutateOnes; non-isolated transactions race-condition"). Treat transactions as unavailable until the model is rebuilt.

**Find:**
```sh
grep -rEn "\.transaction\(|\bcommit\(\)|\brollback\(\)" src/
```

### 4d. `resolver.toResultSet(model, data, method)` → `resolver.toResultSet(model, data)`

The third arg fed the now-removed `Response` event. Pass two args; extra args are ignored but clean them up.

**Find:**
```sh
grep -rEn "\.toResultSet\(" src/
```

### 4e. `createNamedQuery` / `resolver.named()` → `Resolver.$loader` / `resolver.loader()`

Per-model named queries are gone. Named queries are now a top-level static registry, request-scoped via DataLoader.

**Before:**
```js
model.createNamedQuery('topProviders', (resolver, args) => ...);
await resolver.named('Provider').topProviders(args);
```
**After:**
```js
Resolver.$loader('topProviders', (args, context) => ...);
await resolver.loader('topProviders').load(args);
```

The callback signature is `(args, context)` — no more passing the resolver as first arg.

**Why:** Named queries weren't naturally per-model — they often crossed models or were composition-level concerns. Lifting them out of `Model` makes them a first-class request-scoped batchable unit. Using `Resolver.$loader` (static) centralizes the registry without making consumers manage it.

**Find:**
```sh
grep -rEn "createNamedQuery|resolver\.named\(" src/
```

---

## 5. QueryBuilder fluent API

### 5a. Removed/folded methods

| 0.12 | 0.14 | Notes |
|---|---|---|
| `.match(filter)` (alias for `where` w/o merge) | `.where(filter)` | `.where()` now `mergeDeep`s, so `.match()` is redundant |
| `.merge(args)` | `.where(args)` or `.args(args)` | The merge variant is folded in |
| `.search(text)` | n/a | Free-text search must go through driver-specific mechanism (`.native()` or directives) |
| `.batch(field)` | n/a | DataLoader auto-derives batch key from `where` |
| `.transaction()` | gone | See §4c |

`.match(model)` (with a single string arg as the model name) on the **resolver itself** is unchanged — that's `resolver.match('Network')`. The removal applies to the QueryBuilder's `.match(filter)` method.

**Find:**
```sh
grep -rEn "\.merge\(|\.search\(|\.batch\(['\"]" src/
```

### 5b. `.resolve(...)` signature collapsed to one argument

**Before:** `.resolve(root, args, context, info)`
**After:**  `.resolve(info)` — pass other inputs via `.args(args)`, `.info(info)`, etc. on the builder beforehand.

```js
// Before
resolver.match('Place').resolve(root, args, context, info);

// After
resolver.match('Place').args(args).resolve(info);
```

**Why:** `root` and `context` are already on the QueryResolver instance. Only `info` is needed at terminal time (to inspect the return type and pick `one|many|count|connection`).

**Find:**
```sh
grep -rEn "\.resolve\([^i)]" src/    # .resolve( followed by something other than info) or )
```

### 5c. `.first(n)` / `.last(n)` are no longer terminal

They now set a cursor-pagination param and call `.many()` for you. Behavior is identical for callers who use them as terminals; only chaining-after is affected.

**Find:**
```sh
grep -rEn "\.first\([0-9]+\)\.|\.last\([0-9]+\)\." src/
```

---

## 6. Emitter / Events

### 6a. Event payload: flat → nested under `query`

The legacy spread is gone. Every property except `schema`, `context`, `resolver` lives under `event.query`.

**Before (0.12):**
```js
emitter.on('preMutation', (event, next) => {
  event.model;     // model name
  event.crud;      // 'create' | 'update' | 'delete'
  event.doc;       // pre-image (update only)
  event.merged;    // post-transform write payload (Proxy)
  event.input;     // unflattened raw user args
  event.args;      // raw call-site args
  event.key;       // 'createNetwork' etc.
  next();
});
```

**After (0.14):**
```js
emitter.on('preMutation', (event, next) => {
  // event === { schema, context, resolver, query }
  event.query.model;
  event.query.crud;
  event.query.doc;
  event.query.input;        // post-transform Proxy — mutations re-run pipeline rules
  event.query.merged;       // read-only Proxy: input first, falls back to doc
  event.query.args;         // raw args
  event.query.args.input;   // unflattened raw user input (was event.input in 0.12)
  event.query.key;
  next();
});
```

**Why:** In 0.12 there were two distinct things called "merged" (the post-transform Proxy; the doc∪input read view) and two distinct things called "input" (raw args input; the post-transform Proxy aliased as `event.merged`). One source of truth = `query`, with named properties that mean exactly one thing each. Per the notes file: *"query IS the single source of truth (no more merged, no more top-level aliases)."*

**Find:**
```sh
grep -rEn "event\.(model|crud|doc|merged|args|key|payload|input|result)\b" src/
```

### 6b. `input` and `merged`: write through input, read through merged

The canonical pattern in AG14:
- **Write through `event.query.input`.** It's a Proxy whose `set` trap re-runs the field's pipeline (`$cast → $normalize → $instruct → $construct/$restruct → $serialize`). Setting `event.query.input.foo = bar` casts/normalizes `bar` and stores the result.
- **Read through `event.query.merged`.** It's a Proxy that returns the post-write view: input first, with deep fall-through to `doc` for any field input doesn't have. Object spread, `Object.keys`, `Object.entries`, `JSON.stringify`, `in`, and arbitrarily-nested property access all see the deep-merged view.

`event.query.merged` is treated as **read-only** by convention. The proxy doesn't have a `set` trap, so default writes fall through to the input target at the top level — but for nested writes (`merged.foo.bar = x`), the write goes to whichever object the get-trap returned, which can accidentally mutate `doc`. **Don't write to merged. Write to input.**

**Before (0.12):**
```js
emitter.on('preMutation', (event, next) => {
  event.merged.name = 'override';                        // write
  if (event.merged.designation === 'building') { ... }   // read
  next();
});
```

**After (0.14):**
```js
emitter.on('preMutation', (event, next) => {
  event.query.input.name = 'override';                         // write
  if (event.query.merged.designation === 'building') { ... }   // read
  next();
});
```

**Auto-populated input is now clean.** In an earlier iteration of 0.14, the create/update transformer set `keepUndefined: true` and seeded `undefined` for every pipeline-bearing model field — this caused `event.query.input` (and recursive sub-objects within it) to contain `undefined` for every field the user didn't supply. That's gone. The transformer now tracks "user-provided" keys via a non-enumerable `$userProvided` Set on the proxy target; the `set` trap stores a result if (a) the user provided that key, or (b) the pipeline actually produced a non-undefined value (auto-populated fields like `createdAt`, `userId`, `network`). Fields with no value get no entry. So `event.query.input.screen` for a partial update returns just `{searchPlaceholderText: 'foo'}` (the user-provided keys plus any auto-populated ones), not `{ctaText: undefined, ctaImage: undefined, ..., searchPlaceholderText: 'foo'}`. Validation (`required`-checks for fields the user didn't provide) is handled by an independent seeding on the `validate` transformer, so missing-required fields still throw.

**Footguns:**
- `event.query.merged` is only defined for `create` / `update` / `delete` events — not for read/count.
- On `delete`, `event.query.merged` is functionally a read-only view of `doc` (the proxy target is a throwaway `{}`). Prefer reading `event.query.doc` directly when the intent is "the record being deleted."
- To explicitly clear a field on update, pass `null`. `undefined` means "not provided" — the proxy will fall through to the doc value, which is rarely what you want for a clear.
- **Transient GraphQL-only input fields are stripped from `event.query.input`.** The create/update transformer runs with `strictSchema: true`, so any field declared on a GraphQL input type (`XCreateInput`, `XUpdateInput`) but *not* on the model `X` is silently dropped during transform. Common case: a `UserCreateInput` has `role: String!` but `User` only has `roles: [Role!]!`; after transform, `event.query.input.role` is gone. Read it from `event.query.args.input.role` instead — `args.input` is the raw GraphQL input, never touched by the transformer. preMutation hooks that map transient inputs onto the persisted shape (or pass them to authorization rules) should always source from `args.input`, not `input`.

### 6c. `event.result` → `event.query.result`

```js
// Before
emitter.on('postMutation', (event) => console.log(event.result));
// After
emitter.on('postMutation', (event) => console.log(event.query.result));
```

In `postQuery` listeners that call `next(value)`, return `next(event.query.result)` (or whatever shaped value is appropriate).

**Find:**
```sh
grep -rEn "event\.result\b" src/
```

### 6d. `event.query.doc`: pre-image, undefined for create

`event.query.doc` is the pre-image — the document as it existed in the database before this mutation. For:
- **`update`** — the fetched doc.
- **`delete`** — the doc being deleted.
- **`create`** — `undefined`. There's no pre-image. (AG12 used to fabricate a defaulted `{}` here via `model.shapeObject(inputShape, {}, query)`, but that was loose — it pretended to be a pre-image while it wasn't.)

**Migration:** any postMutation listener that runs for both create and update and reads `doc.X` will throw on create. Use either:
```js
const { doc } = query;
if (input.kioskEnabled && !doc?.kioskEnabled) { ... }   // optional chaining

// or:
const { doc = {} } = query;                              // defensive default at destructure
if (input.kioskEnabled && !doc.kioskEnabled) { ... }
```

For "what does the doc look like after the write?", use `event.query.merged` (preMutation) or `event.query.result` (postMutation) — those handle the create case naturally.

**Find:**
```sh
grep -rEn "doc\.\w+|\bdoc\." src/   # then audit each — does the listener fire for create? if so, default or use ?.
```

### 6e. `pre|postResponse` events removed

The `Response` event was emitted on every shaped result, including in-memory shapes via `Resolver.toResultSet`. It duplicated `postQuery`/`postMutation` and was footgun-y because it couldn't be distinguished from a real driver hit.

**Replacement:** listen on the specific `postQuery` / `postMutation` event for the operation you care about. For "doc was shaped" hooks, use `@field(deserialize: ...)` pipeline stages.

**Find:**
```sh
grep -rEn "['\"]pre|postResponse['\"]|preResponse|postResponse" src/
```

### 6f. `Emitter.on('setup', ...)` payload changed

The setup listener now receives the **parsed schema POJO** (`{ models, enums, scalars, indexes, namespace, getModel }`), not a `Schema` class instance.

```js
// Before
Emitter.on('setup', (schema) => {
  schema.getModels().forEach(model => model.getIndexes().forEach(...));
});
// After
Emitter.on('setup', (parsedSchema) => {
  Object.values(parsedSchema.models).forEach(model => model.indexes?.forEach(...));
});
```

**Why:** The old `Schema` instance had a rich method API (`.getModels()`, `.getModel(name)`, `model.shapeObject()`, etc.) — every method became part of the public contract. Passing a frozen POJO lets the author refactor internals freely; the contract is the data shape only.

**Find:**
```sh
grep -rEn "Emitter\.on\(['\"]setup['\"]" src/
```

### 6g. Listener registration: priority + arity-based execution

```js
emitter.on('preMutation', listener, 10);            // priority arg (higher runs first)
emitter.once('preMutation', listener, 5);
Emitter.onModels('preMutation', ['Network'], listener, 10);
Emitter.onceModels(...);                            // new
```

Within a single `emit()`:
1. All "basic" listeners (arity `< 2`) run synchronously up-front, sorted by priority desc. Returning a non-Promise truthy value from a basic listener short-circuits the whole emit (becomes the resolved result via internal `AbortEarlyError`).
2. All "next-style" listeners (arity `>= 2`) run as a `next()` middleware chain afterward, also priority-sorted. `next()` is mandatory; passing a value to `next(value)` short-circuits.

**Why:** Multiple modules need to declare ordering between hooks; `prependListener` was the only 0.12 lever and it didn't compose. Splitting basic vs next-style is also a perf optimization — synchronous read/observe listeners don't pay `new Promise()` per-listener cost. The cache (`#getListeners`) memoizes the sorted partition (commit `2598d4e`).

> **Async basic listeners are fire-and-forget.** A basic (arity-1) listener that returns a Promise has its return value ignored — the emit does not await it. This is intentional: register an async listener as arity-1 when you want a side effect (audit log, metrics emit) that should not block the pipeline. If you need the emit to wait for your work, register as arity-2 and call `next()` after `await`-ing.

### 6h. `Emitter` is a singleton instance

`module.exports = new Emitter().setMaxListeners(100)`. The class is private. All listeners must register against the shared instance.

**Find:**
```sh
grep -rEn "new (Emitter|EventEmitter)\b" src/
```

---

## 7. Result objects: plain JS, mutable, decoupled from cache

In 0.12 results were Proxy-wrapped via `model.shapeObject(...)` with on-access deserialize traps; the Proxy *was* the cache entry, so mutating a result poisoned subsequent dataloader hits.

In 0.14 results come from a per-model compiled `model.docTransform(doc, args)` — a plain function returning a plain JS object. `$`, `$model`, `$cursor`, `$save`, `$lookup` are still attached as non-enumerable properties. **DataLoader caches the raw driver result, not the docTransform output**, and each call to `docTransform` produces a fresh object.

**Implications:**
- Safe to `JSON.stringify`, spread, mutate.
- No more lazy/dynamic field access running pipeline traps. If you didn't `select` it or it isn't in the doc, it's `undefined`.
- ~60% faster `findMany` per the notes file.

---

## 8. `index.js` exports diff

| Symbol | 0.12 | 0.14 |
|---|---|---|
| `Schema`   | ✅ | ✅ |
| `Resolver` | ✅ | ✅ |
| `Pipeline` | ✅ | ✅ |
| `Emitter`  | ✅ | ✅ |
| `Driver`   | ✅ | ❌ — use `require('@coderich/autograph-mongodb')` |

**Find:**
```sh
grep -rn "require('@coderich/autograph')" src/    # audit destructures for 'Driver'
```

---

## 9. Dependencies & engine

| | 0.12.9 | 0.14.4 |
|---|---|---|
| `engines.node` | `>=22.0.0` | not declared (works on Node 18+; native private fields used) |
| `mongodb` | `6.9.0` (direct) | not in core; `@coderich/autograph-mongodb` requires `mongodb@6.16.x` |
| `lodash` | `4.x` (full) | replaced with `lodash.get`/`lodash.merge`/`lodash.uniqwith` micro-packages |
| `@hapi/boom` | `9.1.4` | `10.0.1` (CommonJS-friendly but stricter; verify any `instanceof Boom` checks) |
| Added | — | `@graphql-tools/merge`, `@graphql-tools/resolvers-composition`, `bson-objectid`, `graphql-parse-resolve-info` |

---

## 10. Cheat sheet for the migration

A consumer migrating a typical setup will need to:

1. `npm install @coderich/autograph-mongodb` and remove any direct `mongodb` import that relied on autograph's transitive dep.
2. Rewrite the bootstrap (Schema config object → `.framework().merge().decorate().api()` → Resolver options bag). Drop `context.autograph = { resolver }` — it's automatic.
3. Move index creation out of `schema.setup()` — drive it from migrations or a dedicated bootstrap step that walks `parsedSchema.indexes`.
4. Update every emitter listener — destructure shape: `const { ..., input, merged, doc, crud, key, ... } = event;` → `const { ..., query: { input, merged, doc, crud, key, ... } } = event;`. Top-level `context`, `resolver`, `schema`, `query` stay top-level.
5. Adopt the **"read merged, write input"** rule. AG12-style `event.merged.x = v` writes are tolerated for top-level fields but break silently for nested writes. Migrate every `merged.X = ...` to `input.X = ...`.
6. **postMutation listeners that handle both create and update**: `query.doc` is `undefined` for create. Use `doc?.X` or `const { doc = {} } = query;` to avoid `Cannot read properties of undefined`.
7. **Bulk-style flat-keyed inputs** (e.g. `[{ id, 'name.es': 'foo' }]`): self-`unflatten(item)` before `save(item)`. AG12's auto-`unravelObject` is gone — AG14's transformer-side `Util.unflatten(input, { safe: true })` treats arrays as leaves.
8. Replace `event.result` → `event.query.result`.
9. Remove any `pre|postResponse` listeners. Move that logic into `postQuery` / `postMutation` or into a `@field(deserialize: ...)` stage.
10. Update `Emitter.on('setup', ...)` listeners to use the parsed-schema POJO shape.
11. Directive args: `transform` → `normalize`; `gqlScope`/`dalScope`/`fieldScope` → `crud`+`scope`; `toId` → `serialize: "$fk"` (with the quotes — `$fk` isn't a valid bare GraphQL identifier; the auto-add for FK/PK fields means you can usually just remove the directive entirely); embedded models that opted out of timestamps via `createdAt: null, updatedAt: null` → `decorate: id` (or whichever decorator template fits).
12. Rewrite `.resolve(root, args, ctx, info)` calls to `.args(args).resolve(info)`.
13. Remove `.match(filter)`, `.merge(args)`, `.search(...)`, `.batch(...)` calls from the QueryBuilder; fold them into `.where()` / `.args()` / `.native()`.
14. Replace `resolver.disconnect(...)` with a direct call to the driver client's `.disconnect()`.
15. If you have any `createNamedQuery` usage, port to `Resolver.$loader` / `resolver.loader().load()`.
16. Audit any code that mutated read results expecting it to *not* be visible later — that footgun is gone, but the inverse (relying on lazy/dynamic field traps) is also gone.
17. Consider any custom driver subclass: rebase on `@coderich/autograph-mongodb`'s `MongoDriver` instead of the (now-removed) bundled one.

---

## Unresolved

Places where the author intent isn't yet decided. The migration can proceed without resolving these, but they're worth thinking about before the doc is "final."

1. **`.info(info)` is a no-op.**
   The body is commented out; `.info()` returns `this` without doing anything. The notes file says: *"I disabled it... when selecting 'count' only there are problems."* Schema-generated resolvers still call it routinely, so it's dead code on the hot path. Either restore the body (and fix the count-only-select issue), or remove the method and stop the auto-generated resolvers from calling it. No consumer impact today, but it's confusing dead code.

2. **`merged` write enforcement.**
   `event.query.merged` has no `set` trap. Top-level writes silently succeed (default proxy behavior writes to the input target); nested writes (`merged.foo.bar = x`) can accidentally mutate `doc` when input doesn't have that path. We've documented "don't write to merged" as the consumer rule, but adding throwing `set` / `defineProperty` / `deleteProperty` traps would enforce it. Risk: surfaces every consumer that still uses the AG12 `merged.X = ...` write pattern. **Path forward agreed:** add the throwing traps after we've worked through more module migrations and surfaced any remaining write-to-merged patterns naturally.

## Resolved (during migration)

These were on the unresolved list earlier in the migration; they're now decided. Captured here briefly so the rationale isn't lost.

1. **`event.query.merged` is a stable, deep, read-by-convention Proxy.** Falls through to `doc` recursively on plain-object sub-fields. Spread / `Object.keys` / `JSON.stringify` / `in` all see the deep view. Arrays are returned as-is (no positional element merge — too risky without IDs).
2. **Async basic listeners are intentional fire-and-forget.** A basic (arity-1) listener returning a Promise has its return value ignored; the emit doesn't await it. Use arity-2 if you need the emit to wait for your async work.
3. **`xschema` parameter on Resolver** is available; treat it as experimental until the in-process `resolver.graphql({...})` flow has more usage.
4. **Index creation** is consumer-owned; Spitfire is already in this state via migrations.
5. **`Pipeline.toId`** removed without a transitional shim — migrate to `$fk` (auto-added for FK/PK; explicit `serialize: "$fk"` for corner cases where the schema can't resolve a model link).
6. **`Transformer` was never exported** in 0.12 either; not a regression.

## Spitfire-specific notes

Findings from the Spitfire-side audit, captured here so the migration plan has accurate scope.

### Static facts
- **Indexes**: zero `@index` directives in module schemas; indexes are managed by `migrations/`. No work needed for the consumer-owned-indexes contract.
- **Transactions**: not used in production code. The `meta.mutator` pattern in BulkDataProcessor is not autograph-driven, so the "transactions removed" change has no consumer impact for Spitfire.

### Single-occurrence migrations applied
- **`toId` → `serialize: "$fk"`**: 1 site — `module/NetworkPromotionItem/schema.graphql:6`. The field's type is a union (`NetworkPromotionItemPayload = NetworkPlace`), so it doesn't auto-resolve as a FK reference and needs the explicit form.
- **`createdAt: null, updatedAt: null` → `decorate: id`**: 1 site — `module/@support/DataFacet/schema.graphql:50`. AG14 ignores the `createdAt: null` / `updatedAt: null` `@model` args (those were AG12 syntax for opting out of timestamps); the AG14 way is `decorate:` pointing at a config-defined SDL template.
- **Custom Mongo driver subclass**: `src/merlin/src/driver/Mongo.js` was a subclass of AG12's bundled `Driver` overriding `aggregateQuery` for Atlas `$search`. Needs to be rewritten to extend `@coderich/autograph-mongodb`'s exported MongoDriver, or composed around it. **Not yet migrated** as of this writing — flag for whenever Atlas search functionality gets exercised.

### Recurring migration patterns hit during module-by-module migration
- **AG12-shape `event` destructure** — old: `const { input, merged, doc, ... } = event;`, new: `const { query: { input, merged, doc, ... } } = event;`. Hit in ~25 setup.js files; swept in one pass once we'd seen the pattern enough.
- **"Read merged, write input"** — many AG12-era listeners write through `merged.X = value`. With AG14's read-only-by-convention `merged`, those writes are technically tolerated for top-level assignment but break for nested assignment when input doesn't have the path. Migrate to writing through `input` directly.
- **`doc` undefined on create** — postMutation listeners that reach into `doc.X` and fire for both create and update need `doc?.X` or `const { doc = {} } = query;`.
- **Bulk-style flat-keyed inputs** — Spitfire's BulkDataProcessor sends `[{ id, 'name.es': 'foo', 'contact.exceptionHours': [{ id, 'name.es': 'bar' }] }]` style input. AG12's `QueryBuilder.save` auto-deep-unflattened via `unravelObject`; AG14 only unflattens at the top level (`Util.unflatten(input, { safe: true })` treats arrays as leaves). Bulk processors must call `unflatten(item)` before passing to `save`.
- **Dead `pre|postResponse` listeners** — three flagged (Network/setup.js:101 preResponse, @1.setup/subscriptions.js:17 preResponse, @1.setup/subscriptions.js:27 postResponse — the Redis pub/sub publisher, **significant**). They register but never fire under AG14. Migrate to `postQuery` / `postMutation` or remove. The subscriptions.js postResponse handler is load-bearing for the subscription notification mechanism — needs explicit treatment when subscriptions are exercised.

### Still ahead
- **`setup` listener payload**: 3 occurrences (`User/setup.js`, `@1.setup/transformations.js`, `@support/DataValidation/setup.js`) — all need to treat the listener arg as a parsed-schema POJO (not a `Schema` instance with methods). Verify when their tests run.
- **NetworkDeepLinkConfiguration**: setup uses AG12 `query.toObject()` calls and `$query.match` (the old where-clause name). Migrated to `query.where` + clean read-merged/write-input pattern, but no test coverage for this module — verify when something exercises it.

---

# Upgrading to autograph 0.15

This guide covers every breaking change introduced between `0.14.x` and `0.15.x`.

---

## Removed deprecations

### `Schema.getModels()` and `Schema.getModel(name)` removed

These public accessors were deprecated in 0.14 and are now removed.

**Before:**
```js
const models = schema.getModels();
const person = schema.getModel('Person');
```

**After:** Access the parsed schema POJO instead (available from the `setup` event or via `schema.toObject()`):
```js
emitter.on('setup', ({ models }) => {
  const person = models.Person;
});
```

---

### `parsedSchema.getModel(name)` removed from setup payload

The `getModel` function that was attached to the `parsedSchema` object passed to `emitter.on('setup', ...)` is no longer present.

**After:** Use `parsedSchema.models[name]` directly.

---

### `@field(transform: [...])` removed

The `transform` pipeline directive argument was renamed to `normalize` in 0.14 and the backwards-compat shim is now gone.

**Find:** `grep -r "transform:" schema/` — look for `@field(transform: ...)` in GraphQL SDL files.

**Before:**
```graphql
name: String @field(transform: ["toLowerCase"])
```

**After:**
```graphql
name: String @field(normalize: ["toLowerCase"])
```

---

### `@model(gqlScope:)`, `@model(fieldScope:)`, `@field(gqlScope:)`, `@field(dalScope:)` removed

These directive arguments were renamed to `crud` and `scope` in 0.14. The backwards-compat shims and the SDL arguments themselves are now removed.

**Find:** `grep -r "gqlScope\|dalScope\|fieldScope" schema/`

**Before:**
```graphql
type Person @model(gqlScope: "crud") { ... }
name: String @field(gqlScope: "r", dalScope: "crud")
```

**After:**
```graphql
type Person @model(crud: "crud") { ... }
name: String @field(crud: "r")
```

---

### `@model(driver:)`, `@model(createdAt:)`, `@model(updatedAt:)`, `@field(ref:)` removed

These transitional `@model` and `@field` directive arguments (present since 0.14 only to ease migration) are now removed from the framework SDL.

- `@model(driver: ...)` → use `@model(source: ...)` (the renamed form from 0.14)
- `@model(createdAt:)` / `@model(updatedAt:)` → these were AG12 syntax; use a custom `decorate:` config instead
- `@field(ref: ...)` → specify the model reference through the type system or `@link`

---

### `AppService.withResolvers` export removed

The re-exported `withResolvers` helper from `@coderich/util/AppService` was a one-release alias for `Promise.withResolvers`.

**Find:** `grep -r "withResolvers" src/` — look for imports of this from autograph internals.

**After:** Use `Promise.withResolvers()` directly (available natively in Node 22+, and polyfilled by autograph's minimum supported Node version).

---

### `AppService.guidToId(autograph, guid)` — `legacyMode` branch removed

The `legacyMode` branch (which returned `guid` as-is when `autograph.legacyMode` was truthy) is removed. The function now always decodes the GUID.

**Before (legacy path):** If `autograph.legacyMode` was set, raw GUIDs were passed through unchanged.

**After:** GUIDs are always decoded via `fromGUID`. Remove any `legacyMode` flag from your autograph config.
