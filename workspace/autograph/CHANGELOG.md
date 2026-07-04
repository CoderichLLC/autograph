# CHANGELOG

## v0.16.x (BREAKING)
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
  - PostgresDriver: production-pure (all pg-mem emulation moved to test harness `PgMemShim`); real `BEGIN ISOLATION LEVEL REPEATABLE READ` + native rollback

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
