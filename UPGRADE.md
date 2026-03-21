# Upgrading to autograph 0.14.0

This guide covers every breaking change introduced in 0.14.0. Entries are added as changes are made — nothing speculative.

---

## Emitter / Hooks

### Event object shape

The event passed to all hooks is now `{ schema, context, resolver, query }`. Previously all query properties were spread directly onto the event object. Everything is now accessed under `event.query`.

**Before:**
```js
emitter.on('preMutation', (event, next) => {
  event.model;
  event.crud;
  event.doc;
  event.args;
  next();
});
```

**After:**
```js
emitter.on('preMutation', (event, next) => {
  event.query.model;
  event.query.crud;
  event.query.doc;
  event.query.args;
  next();
});
```

### `event.merged` is removed — use `event.query.input`

`event.merged` was the post-transform Proxy representing what would be written to the database. It is now accessible as `event.query.input`, which is the same Proxy — setting a field on it still re-runs that field's pipeline rules.

**Before:**
```js
emitter.on('preMutation', (event, next) => {
  event.merged.name = 'override';
  event.merged.updatedBy = context.userId;
  next();
});
```

**After:**
```js
emitter.on('preMutation', (event, next) => {
  event.query.input.name = 'override';
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

### `event.input` (unflattened args) is removed

The legacy `event.input` (which held the unflattened raw user args, distinct from `event.merged`) is removed. Use `event.query.args.input` if you need the original user-supplied input, or `event.query.input` for the post-transform value that will be written.
