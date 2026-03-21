# Upgrading to autograph 0.14.0

This guide covers every breaking change introduced in 0.14.0. Changes are grouped by area. Each entry describes what changed, what the old pattern looked like, and what replaces it.

---

## Emitter / Hooks

### Event object shape

The event passed to all hooks is now `{ schema, context, resolver, query }`. All query state lives under `event.query`. Nothing is spread onto the top-level event object anymore.

**Before:**
```js
emitter.on('preMutation', (event) => {
  event.model;       // query property spread onto event
  event.crud;
  event.input;       // unflattened user input
  event.merged;      // post-transform proxy (what actually gets written)
  event.doc;         // existing document (updates)
  event.args;
});
```

**After:**
```js
emitter.on('preMutation', (event) => {
  event.query.model;
  event.query.crud;
  event.query.input; // raw user input (before transform)
  event.query.doc;   // existing document (updates)
  event.query.args;
});
```

### `event.merged` is removed — use `event.query.input`

`event.merged` was the post-transform Proxy used to override what gets written. It is removed. Set fields on `event.query.input` instead — transform runs after `preMutation`, so pipeline rules (cast, normalize, serialize, etc.) still apply to anything you set.

**Before:**
```js
emitter.on('preMutation', (event, next) => {
  event.merged.name = 'override';        // ran through pipeline
  event.merged.updatedBy = context.userId;
  next();
});
```

**After:**
```js
emitter.on('preMutation', (event, next) => {
  event.query.input.name = 'override';       // pipeline runs after this hook
  event.query.input.updatedBy = context.userId;
  next();
});
```

### `event.result` is removed — use `event.query.result`

**Before:**
```js
emitter.on('postMutation', (event) => {
  console.log(event.result);
});
```

**After:**
```js
emitter.on('postMutation', (event) => {
  console.log(event.query.result);
});
```

### Hook timing summary

```
transform()  → cast, normalize, instruct, construct/restruct, serialize
  ↓
preMutation  → event.query.input is the post-transform Proxy; setting a field re-runs
               its pipeline rules. Can abort early by returning a value from a basic listener.
  ↓
validate     → throw to reject; can still modify event.query.input via the Proxy
  ↓
driver write
  ↓
postMutation → event.query.result available; basic listener return overrides result
```

`event.query.input` in `preMutation` is the post-transform Proxy. This means data is already cast, normalized, and serialized when your hook runs — comparisons against `query.doc` (the existing document) are safe because both are in the same normalized form. Setting a field on `event.query.input` re-runs the pipeline rules for that field.

---

## Resolver

### Removed aliases

`resolver.driver` and `resolver.model` were aliases. Use the canonical methods directly.

**Before:** `resolver.driver(modelName)` / `resolver.model(modelName)`
**After:** `resolver.raw(modelName)` / `resolver.match(modelName)`

### `getModels()` / `getModel()` removed

**Before:** `resolver.getModels()` / `resolver.getModel('Person')`
**After:** `resolver.getSchema().models` / `resolver.getSchema().models['Person']`

### `$save` / `$lookup` shims removed from result documents

Result documents no longer have `$save` or `$lookup` as direct properties. Use the `$` proxy instead.

**Before:**
```js
const person = await resolver.match('Person').id(id).one();
await person.$save({ name: 'new name' });
const books = await person.$lookup('books', args);
```

**After:**
```js
const person = await resolver.match('Person').id(id).one();
await person.$.save({ name: 'new name' });
const books = await person.$.lookup('books').args(args).many();
```

---

## QueryBuilder

### Removed aliases

| Removed | Use instead |
|---|---|
| `.opts(...)` | `.options(...)` |
| `.sortBy(...)` | `.sort(...)` |
| `.remove()` | `.delete()` |

---

## Schema directives

### `gqlScope` / `fieldScope` removed

**Before:**
```graphql
type Person @model(gqlScope: "cru") {
  name: String @field(gqlScope: "r")
}
```

**After:**
```graphql
type Person @model(crud: "cru") {
  name: String @field(crud: "r")
}
```

### `@field(transform: ...)` removed

The `transform` directive argument was renamed to `normalize` in an earlier version. The deprecated alias is now gone.

**Before:** `name: String @field(transform: "toLowerCase")`
**After:** `name: String @field(normalize: "toLowerCase")`

---

## Transactions

Transactions have been removed in 0.14.0 due to unresolved race conditions with the session/resolver model. `resolver.transaction()`, `resolver.commit()`, `resolver.rollback()`, and `resolver.run()` are removed. Any code that wraps operations in a transaction block needs to be updated to run operations directly and handle consistency at the application level until a safe transaction implementation is introduced.

---

## Pipeline

### `toId` pipeline removed

**Before:** `id: ID @field(serialize: "toId")`
**After:** Define a custom pipeline — e.g. `Pipeline.define('toObjectId', ...)` — and reference it by name.

### Removed pipeline names

| Removed | Replacement |
|---|---|
| `transform` | `normalize` |
| `deserialize` | *(no replacement — pipeline no longer runs on DB results)* |
| `destruct` | *(removed)* |

### Pipeline no longer runs on database results

Deserialization pipelines no longer run on data returned from the driver. If you were using `deserialize` to transform raw DB values into application values, move that logic to the `doc` transformer or a `postQuery` hook.

---

## `$Magic` methods

The `$` proxy on result documents has a new signature. Methods are now properly chainable.

**Before:** `doc.$save(input)` / `doc.$lookup(field, args)`
**After:** `doc.$.save(input)` / `doc.$.lookup(field).args(args).many()`

---

## Named queries / loaders

`createNamedQuery` is replaced by `Resolver.$loader`.

**Before:**
```js
createNamedQuery('myQuery', (id) => resolver.match('Person').id(id).one());
```

**After:**
```js
Resolver.$loader('myQuery', resolver, {
  load: (args, context) => context.autograph.resolver.match('Person').id(args.id).one(),
});
```

The callback now receives `(args, context)`. Cache is on by default and persists for the lifetime of the loader — call `loader.clearAll()` to invalidate.

---

## Context namespace

The resolver is now available at `context.autograph.resolver` (where `autograph` is the configurable namespace). Previously it may have been at a different path.

---

## MongoDB driver

`MongoClient` is now a separate package: `@coderich/autograph-mongodb`. Add it as an explicit dependency and update your data source config accordingly.

---

*This file is maintained alongside active 0.14.0 development. Entries will be added as additional backwards-compatibility code is removed.*
