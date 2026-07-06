# CHANGELOG

## v0.16.x (BREAKING)
  - Performance baseline (Part 1): driver-call budgets are now a TestSuite conformance section (`instrumentClient`, exported from `@coderich/autograph-db-tests`, wraps a driver's `execute`/`prepare` to assert per-scenario call counts); `workspace/autograph/bench/` harness added — a standalone (non-Jest) CPU/latency benchmark (`npm run bench`) isolating framework CPU (zero-latency `InstantDriver`) from round-trip cost (`InstantDriver.withLatency`); see `bench/RESULTS.md` for baseline numbers that later elision/compilation work is measured against
  - Performance (Part 2): pre-image elision drops `updateOne`/`deleteOne` from 2 driver calls to 1 on doc-free models
    - **Driver contract: mutations return docs, not acknowledgements** — `updateOne`/`deleteOne` (all three drivers: Mongo, Postgres, Redis) now return the affected row (`deleteOne` returns the pre-image row) instead of a bare ack/count; autograph's write path consumes that returned row directly rather than always issuing a separate pre-fetch
    - `$model.updateDocFree` / `$model.deleteDocFree` (computed at `schema.parse()`): a model is update-doc-free when no update-stage pipeline (`validate/restruct/instruct/normalize/serialize`) reads `query.doc`/`query.merged` (pipeline entries opt in via a `docSafe` tag; anything unprovable conservatively blocks elision) and it has no embedded fields; delete-doc-free when it has no referential-integrity edges
    - `$model.preImage` is the elision-aware slot `terminate()` always awaits: on a doc-free model with no registered mutation-lifecycle listener for that model it resolves `undefined` (skipping the pre-fetch entirely) — a listener registered via `Emitter.on`/`observe` for any mutation event transparently restores the pre-fetch, since hooks are entitled to `query.doc`
    - the 404 contract is preserved when elided: `flags.required` rides forward and is enforced against the driver's returned post-image instead of the pre-fetch (same error class/message)
    - Driver-call budgets flipped: `updateOne budget` and `deleteOne budget (no RI edges)` now assert 1 call (was 2); two new guard tests conformance-test the listener-restores-elision behavior and that an elided delete still returns the full (deserialized) pre-image row
    - See `bench/RESULTS.md` "After Part 2" — `latency(1ms): updateOne narrow end-to-end` improves ~82% (212 → 386 ops/sec), one fewer round trip per mutation
  - Performance (Part 3): params-object reuse + `docTransform` field partitions — CPU-side follow-ups to Part 2, gated the same conservative way
    - `Pipeline.define(name, fn, { docSafe, argsSafe })` — internal (undocumented) audit metadata: `docSafe` marks a step as never reading `query.doc`/`query.merged` (feeds `updateDocFree`, see Part 2); `argsSafe` marks a step as reading its args bag synchronously and never retaining it, letting the framework reuse ONE args object across a field's step chain instead of spreading a fresh `{ ...args, value }` per step. Every built-in preset (`$cast`/`$normalize`/`$construct`/`$restruct`/`$serialize`/`$deserialize`/`$validate`, `$pk`/`$fk`, `ensureFK`, `dedupe`, the JS string transformers, `Allow`/`Deny`/`Range`) is tagged via a `definePreset` wrapper; `selfless`/`immutable` are `argsSafe` but NOT `docSafe` (they read `query.doc`). Reuse applies in three spots: `Transformer#applyKey`'s per-field step loop, `Pipeline.resolve`'s `$`-structure reduce, and `Pipeline.define`'s own itemize (array) path (mutate-call-restore under try/finally, so a thrown Boom's `data` payload stays byte-identical to the old spread-per-item path)
    - **Custom `Pipeline.define()` calls are conservatively untagged** (`docSafe`/`argsSafe` both default `false`) — they keep paying full per-step allocation and never elide the pre-image; there is no public opt-in yet (deliberately deferred)
    - `$model.docTransform`: the per-field eligibility flags (`isArray`/`hasEmbedded`/`hasDeserialize`/etc.) are now partitioned ONCE at `schema.parse()` instead of re-derived per row per call; models with zero embedded-or-deserialize-eligible fields take a new identity-plus-rename fast path (no lazy-getter machinery, no selection walk)
    - See `bench/RESULTS.md` "After Part 3" — the latency scenario holds Part 2's gain (~+75-81% over baseline); the CPU scenarios this part targeted (read narrow/wide, createOne) show **no measurable delta** on this bench (noise-dominated at this scale) — recorded honestly, not reverted; candidates for follow-up profiling if throughput at larger scale matters
  - Transactions re-introduced (`TransactionScope`) — reference-threaded, never ambient (no ALS)
    - **Every gqlMutation is its own transaction** (isolated clone; `context.autograph.resolver` swapped per field; commit before field resolves)
    - **Inside a custom mutation resolver body, data is PROVISIONAL until the field commits** — inline irreversible side effects (email/webhook) are now rollback-exposed; move them to `postCommit`
    - `mutation @transaction { a, b, c }` escalates to one operation-level unit (executes via first-field hoist; rollback ⇒ `data: null`); a root field merged outside `toObject()` fails the unit loudly (`OPERATION_ABORTED`) — never silently excluded
    - Wrapper errors carry `extensions.{code, committed}` (`PRE_OPERATION_ERROR`/`POST_OPERATION_ERROR`/`MUTATION_ERROR`/`OPERATION_ABORTED`); no `result` on the wire
    - agMutations (`resolver.match().save()` etc.) only JOIN scopes, never create; RI/`*Many` auto-wrap their own
    - `enableAutoTransaction()` / `autoTransaction` flag REMOVED; host escape hatch = `transaction({ isolated: false })`
    - Scopes bind a session on FIRST use (reads included — snapshot isolation); settled scopes: reads degrade to committed, writes reject
    - New events `postCommit` / `postRollback` (durable-outcome observers; failures isolated)
    - Post-phase failures role-graded: `postMutation` throw aborts a carried unit; `preResponse`/`postResponse` throw = `PostOperationError` (commits anyway, `.result` carries the write)
    - Scripts/out-of-band unchanged: awaited ⇒ durable (only `*Many`/RI auto-wrap, bounded within the call)
  - Emitter: listener role declared at REGISTRATION, not arity
    - `on()` = PARTICIPANT: awaited, ambient resolver, throw aborts the mutation, non-undefined return short-circuits (sync return stops later listeners; async return now short-circuits too)
    - `observe()` = OBSERVER: fire-and-forget, DETACHED resolver (committed-only reads; fate-independent writes), failures swallowed, return ignored, runs first
    - **BREAKING: arity<2 listeners via `on()` are now participants** (were fire-and-forget basics) — migrate observers to `observe()`
    - Legacy `(event, next)` form still works (call convention only)
    - One flat priority order per role (no more basics/nexts phases)
    - `event.context[namespace].resolver` is POISONED in hooks (throws) — use `event.resolver` (`.detach()`/`.transaction()` for other fates)
    - Registration collapsed to TWO methods: `on(filter, fn)` / `observe(filter, fn)` — filter = `{ event, model, crud, priority, once, memoize }` (scalar-or-array; string shorthand for bare event; returns a disposer); `once`/`prepend*`/`onModels`/`onKeys`/`observe*` variants REMOVED (poisoned with migration hints); NO `keys` filter (use `model` + `crud`); `hasListenersFor(event, model)` drops the key param
    - Registration validation is LOUD: unknown filter keys, unknown crud flags, empty `event`/`model`/`crud`, and the old trailing-options arg (`on(event, fn, options)`) all throw — nothing silently never-matches or silently drops priority/memoize
  - Where Vocabulary: `$eq $ne $gt $gte $lt $lte $in $nin $exists $not $or $and` first-class in `.where()` AND GraphQL where-inputs (`src/query/Vocabulary.js`)
    - Allowlist validation — unknown `$`-operators now REJECT loudly (was silent passthrough; closes GQL injection surface)
    - Fixed: operators through the normal path silently matched NOTHING on Mongo (finalize flattening bug, incl. the known `$in` bug)
    - Field pipelines/key-mapping apply INTO operator operands at every depth; globs convert inside `$in`/`$nin`
    - Portable semantics: `$exists` = "non-null value present"; `$ne`/`$nin` match missing/null (PG behavior aligned to Mongo)
    - Join paths inside `$or`/`$and` branches reject loudly
    - `flags({ native })` = TRUE driver dialect (unvalidated/untranslated, raw column keys, e.g. Mongo `$expr`) — still transactional/cached
    - Legacy ARRAY-where (`.where([a, b])` OR form) normalizes to `$or` at the builder boundary (was silently match-all after the vocabulary rewrite); `.where([])` now throws via `$or` validation (was also silently match-all)
  - **`resolver.driver()` REMOVED** — use the vocabulary, `flags.native`, or your own client instance; TestSuite raw verification via test-harness `global.rawDriver`
  - **`Resolver.$loader` / `resolver.loader()` REMOVED** — a process-global, args-only-keyed, indefinite cache is unsound under transactions (caches provisional/rolled-back data; bleeds across contexts); per-model DataLoader covers batching, cross-request memoization belongs to the app
  - Driver contract changes (pre-publication): `driver(name)` no longer required; where operators arrive INTACT (never pre-flattened — drop reconstruction); vocabulary conformance section in TestSuite
  - `dataSource.supports` HONORED with graceful fallbacks (consumer-declared; absent = `[]`; nothing throws except one loud edge)
    - **MIGRATION: `'joins'` was previously unread (drivers joined regardless) — add it to existing configs (`supports: ['transactions', 'joins']`) or join-shaped queries downgrade to the planner fallback (correct but slower; unliftable paths reject)**
    - no `'transactions'` → scopes inert for that source: sessionless writes (durable when awaited, uncarried semantics), `commit()` no-op, **`rollback()` cannot undo** (declared = consented)
    - no `'joins'` → QueryPlanner resolves join-shaped where/sort (pre-query → `$in`; in-memory joined sort — correctness-first, not perf-neutral); drivers never receive `query.joins`
    - WHERE lifts cover FK sub-paths (both link directions), embedded-prefix stored FKs (`pins.writer.name` → inject at local `pins.writer`), and bare virtual equality (`{ articles: id }` → foreign-pk condition); injected values re-ride the where pipelines (fixes latent string-vs-ObjectId mismatch in the cross-source path too)
    - LOUD edges (reject, never silent over-matching): join-shaped SORT deeper than a first-segment FK (multi-valued — ill-defined) and WHERE on a virtual link behind an embedded prefix (no local column)
    - `batches`/`referentialIntegrity` flag names dropped (declared/read nowhere)
    - fixes latent crash: a source with NO `supports` key TypeError'd on its first scoped operation (i.e. every gqlMutation)
  - DataLoader raw-cache contract RESTORED (regression: `toResultSet` had moved inside the batch fn, so the cache held transformed doc INSTANCES)
    - cache hits returned the SAME object — caller mutations bled into every later read (violated the documented "safe to mutate" contract); first caller's selection shaping served to all; **`$`-magic bound to the ROOT resolver — `doc.$.save()` on a doc read through a txn clone ESCAPED the transaction**
    - now: cache stores raw rows; transform runs per call with the CALLING resolver + calling query's info; array fields shallow-copied out of the raw row (deep-mutation isolation)
    - cost: cache hits re-run deserialize/docTransform (the price of the contract; a derived memo layer is the future optimization if measured)
    - `QueryBuilder.resolve(info)` now self-attaches its `info` (the field's selection IS the model's selection at that terminal) — user-authored resolvers ending in `.resolve(info)` get selection-aware eager/lazy scheduling for free; bare `.one()`/`.many()` terminals remain all-lazy (correct, unoptimized)
    - offsets: `buildSelectionTree` memoized per `info.fieldNodes` array (graphql-js memoizes collectSubfields, so N sibling parents share the array by identity — N walks collapse to one; per-`info` keying would never hit, since graphql builds a fresh info per invocation); QueryPlanner internal reads no longer narrow `.select()` (internal reads are SUPERSET — pre-queries share one cache identity + merge bucket with same-shaped user reads; select-islands eliminated)
  - Schema DSL references now validate at PARSE time (boot), loudly — the SDL references things GraphQL itself cannot verify, and dangling references previously surfaced as cryptic TypeErrors mid-request in production
    - unknown pipeline names in ANY `@field(...)` stage → all aggregated into ONE boot error naming model.field, stage, and the fix (a typo'd `validate: bookNmae` used to explode on the first WRITE touching the field)
    - `@link(by:)` / `@field(fk:)` naming a nonexistent field on the target model → descriptive parse error (was: `Cannot read properties of undefined (reading 'key')`)
    - `@index(on:)` naming a nonexistent field → descriptive parse error (same cryptic TypeError before)
    - **CONTRACT: define-then-parse** — custom `Pipeline.define()` calls MUST run before `schema.parse()`; a boot in CI is now a full schema reference check
  - NEW driver: `@coderich/autograph-redis` (`workspace/redis-driver`) — vanilla Redis, a deliberate proof of the driver contract's FLOOR
    - one JSON blob per doc + id-set enumeration + client-side Where Vocabulary evaluation (scan → filter → sort → paginate); unique indexes as Lua-atomic maintained hashes; `supports: []` (no transactions — MULTI/EXEC can't do read-your-writes; no joins — QueryPlanner fallback carries every join-shaped query); real `redis-server` test harness (`redis-memory-server`), zero emulation shim; see `workspace/redis-driver/test/NOTES.md` for what the exercise proved
  - TestSuite is now CAPABILITY-AWARE: `testSuite({ supports })` mirrors the consumer's dataSource declaration
    - transactional sections (snapshot isolation, rollback-undoes, batch atomicity, RI mid-walk rollback) bind only drivers declaring `'transactions'`; without it the suite runs the UNCARRIED-semantics variant (writes durable when awaited, `commit()` no-op, `rollback()` cannot undo, settled scopes fully inert) — doctrine asserted, not skipped; `'joins'` needs no gating (planner fallback passes the same assertions)
  - QueryPlanner: multi-hop join-shaped SORT resolution — a first-segment-FK sort whose sub-path crosses FURTHER FK links (`authored.chapters.name`) now resolves recursively (batch-fetch per hop; multi-values reduced direction-aware: min asc / max desc, matching unwind→sort→first-occurrence join semantics); the loud edge narrows to join-shaped sorts NOT starting at a first-segment FK (embedded prefix, bare virtual)
  - QueryPlanner fix: cross-source sort augment values were keyed by the path's FIRST segment — two sort keys sharing a prefix (`authored.chapters.name` + `authored.chapters.temp`) clobbered each other (silent id-order degradation); keyed by full path now
  - PostgresDriver: production-pure (all pg-mem emulation moved to test harness `PgMemShim`); real `BEGIN ISOLATION LEVEL REPEATABLE READ` + native rollback
  - PostgresDriver: real NESTED transactions via SAVEPOINT (was: hand parent handle back = Mongo-style shared fate)
    - a child scope's `rollback()` is now PARTIAL on PG (`ROLLBACK TO SAVEPOINT` — parent survives; on real PG this also un-poisons the 25P02 aborted state, making catch-and-continue hook tolerance actually work); child `commit()` = `RELEASE` (NOT durability — fate folds into the parent)
    - `TransactionScope` gained the NESTED classification (distinct handle from `transaction(parentHandle)`): settled callbacks (`postCommit`, cache clears) are handed UP at nested commit and fire only at the true owner's seal — a savepoint released into a transaction that later rolls back reports `postRollback`; a nested rollback fires `postRollback` promptly
    - sibling savepoint lifetimes serialize through a per-handle gate (savepoints are a linear stack per connection — overlapping siblings would destroy/undo each other); nested chains unaffected
    - behavioral DIVERGENCE by driver capability (by design): the same child-scope rollback is shared-fate on Mongo, partial on PG (`NestedTransactions.test.js` pins PG; TestSuite pins the shared semantics both drivers meet)
    - `PgMemShim` emulates SAVEPOINT/RELEASE/ROLLBACK TO as layered undo state (per-layer first-capture-wins pre-images)

## v0.15.x (BREAKING)
  - Removed all deprecations
  - @oneOf support

## v0.14.x (BREAKING)
  - Transaction support removed
  - PageInfo and cursor no longer required schema (only defined when cursorPaginating)
  - Revamped Pipeline { schema, context, resolver, query, model, field, value, path, startValue }
    - Pipeline "toId" is completely removed (use custom "toObjectId" Pipeline etc)
    - Removed Pipelines [transform, destruct]
      - transform -> normalize
  - Revamped Emitter { schema, context, resolver, query }
    - query IS the single source of truth
    - "Basic" functions are hoisted to the top for execution; RETURNING a value will bypass thunk()
    - "Next" functions are run next, next() must ALWAYS be called; passing a value to next() will bypass thunk()
    - Event shape refactored:
      - event.query.input  (replaces event.merged and old event.input)
      - event.query.result (replaces event.result shortcut)
  - Emitter.on('setup') is passed the "parsedSchema" object
  - No more gqlScope, dalScope, fieldScope (use crud + scope)
  - resolver.resolve() now takes 1 argument (info) and requires you to use .args() etc if need be
  - $magic methods now have signature doc.$.<method> and are more powerful and chainable
  - Resolver now sets itself at context.autograph (configurable)
  - createNamedQuery is replaced by Resolver.$loader
    - cb function now has signature (args, context)
    - cache is on by default and persists indefinitely (must be managed)
  - MongoClient now seperate NPM module @coderich/autograph-mongodb

## v0.11.x
- Node 18.12.1
- Engine >=16.20.0
- Updated deps for vulnerabilities

## v0.10.x
- Replaced ResultSet -> POJOs
  - Removed all $field methods (auto populated)
  - Removed .toObject()
  - $model $save remove $delete $lookup $cursor $pageInfo
- Removed embedded API completely
- Removed Directives
  - embedApi -> no replacement
  - enforce -> use pipeline methods
  - resolve -> use graphql resolvers
  - @value -> use @field.instruct directive
- Removed Model.tform() -> use Model.shapeObject(shape, data)
- Removed Transformer + Rule -> use Pipeline
  - Removed many pre-defined rules + transformers
  - Moved "validator" to dev dependency -> isEmail
- Added QueryBuilder.resolve() terminal command
- Exported SchemaDecorator -> Schema
- Removed embedded schema SystemEvents (internal emitter also removed)
- Removed spread of arguments in QueryBuilder terminal commands (must pass in array)
- Mutate "merged" instead of "input"
- Validate "payload"

## v0.9.x
- Subscriptions API
- postMutation no longer mutates "doc" and adds "result"
- Added onDelete defer option

## v0.8.x
- Engine 14+

## v0.7.x
- Complete overhaul of Query to Mongo Driver (pagination, sorting, counts, etc)
- Removed countModel Queries from the API (now available as `count` property on `Connetion` types)
- Dropped Neo4J (temporarily)

## v0.6.x
- Mongo driver no longer checks for `version` directive
- Models no longer share a Connection type; removing the need to use `... on Model` for GraphQL queries
- Added `@field(connection: Boolean)` parameter to specifically indicate fields that should return a Connection type
