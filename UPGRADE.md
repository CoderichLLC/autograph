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

### `event.merged` semantics changed — write through `input`, read through `merged`

In 0.12, `event.merged` was both the write target *and* the "what will this value be after the write" read view — same object served both purposes. In 0.14 those roles split:

- **Writes go through `event.query.input`** — this is the post-transform target; setting a field on it re-runs that field's pipeline rules. This replaces 0.12's `event.merged.foo = bar` pattern.
- **Reads of "post-write value" go through `event.query.merged`** — a Proxy that reads from `input` first and falls back to `doc` when `input[prop]` is `undefined`. Use it when you want "the value as it will be after this write" without caring whether it came from the user's input or the existing doc.

**Before (0.12):**
```js
emitter.on('preMutation', (event, next) => {
  event.merged.name = 'override';                       // write
  if (event.merged.designation === 'building') { ... }  // read
  next();
});
```

**After (0.14):**
```js
emitter.on('preMutation', (event, next) => {
  event.query.input.name = 'override';                        // write
  if (event.query.merged.designation === 'building') { ... }  // read
  next();
});
```

**Footguns:**
- `event.query.merged` is only defined for `create` / `update` / `delete` events — not for read/count.
- On `delete`, `event.query.merged` is functionally a read-only view of `doc` (writes are silently discarded). Prefer reading from `event.query.doc` directly when the intent is "the record being deleted."
- `{ ...event.query.merged }` (spread) only enumerates `input` keys — doc-only keys aren't visible to spread / `Object.keys`. Enumerate explicitly when you need both: `{ site: merged.site, building: merged.building, directory: input.directory }`.
- To explicitly clear a field on update, pass `null`. `undefined` means "not provided" — the proxy will fall through to the doc value, which is rarely what you want for a clear.

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
