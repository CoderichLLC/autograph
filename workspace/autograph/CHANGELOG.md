# CHANGELOG

## v0.16.7 (unpublished)
  - **Relation-field where operands — the over-match cluster** (found live: `tags: { $exists: false }`, `tags: { $exists: true }` and `tags: { $gt: 0 }` all returned the same count). Three distinct defects, one shared failure mode — the predicate silently degenerated and the query matched every row with any related record:
    - **QueryPlanner flattened wheres generically**, so an operator object on a relation field (`{ tags: { $exists: false } }`) became the join path `tags.$exists` — the planner pre-queried the foreign model with a dangling operator (dropped by its transform → matched ALL related rows) and rewrote the where to `$in: <every id>`. The planner now uses the operator-aware `Vocabulary.flattenWhere` (moved from Query.js's private `#finalize` helper — the driver-joins path already treated operator objects correctly; the fallback now agrees): an operator object on a STORED FK is a field-level predicate on the local column (`labels: { $exists: false }` reaches the driver intact). On a bare VIRTUAL link it refuses loudly ($in injection cannot express the complement; predicate a field of the linked model instead).
    - **The where transformer ran field pipelines on NESTED-WHERE operands**: with `@field(key: "labels", serialize: toString)`, `{ tags: { name: 'red' } }` serialized the nested where to the string `"[object Object]"`, which downstream spread into per-character keys and degenerated to match-all. A plain (non-operator) object on a relation field is query STRUCTURE, not a value — pipelines now skip it (the foreign model's own transform coerces the nested content at join resolution). Scalar operands (bare ids, operator operands) ride pipelines exactly as before.
    - **`Vocabulary.validate` is now POSITION-aware**: a value operator dangling in CLAUSE position (the where root, a compound branch, or the root of a nested relation where) has no field to predicate and was silently dropped by the transform — it now refuses loudly: `operator $exists cannot stand alone — a value operator applies to a field`.
  - `.where(null)` is "no constraint" — identical to omitting the call. GraphQL's nullable `where:` argument delivers exactly this shape; it used to throw a deepmerge TypeError from inside QueryBuilder.
  - **`$size` — the vocabulary's LENGTH predicate** (needs the matching driver release: autograph-mongodb / autograph-pg / autograph-redis from this same publish). `{ tags: { $size: 0 } }`, `{ tags: { $size: { $gt: 0 } } }`, `{ name: { $size: { $gt: 20 } } }`. Semantics, pinned by a new TestSuite conformance section on all three drivers: length = array element count, or String CODE POINTS (mongo `$strLenCP`, PG `char_length` and JS `[...s].length` agree — an emoji is 1); missing/null/wrong-runtime-type count as 0, so `$size: 0` alone is "none" — measured on the dogfood: `$exists: false` found 13 untagged contacts (missing only) while `$size: 0` found the true 41 (13 missing + 28 EMPTY arrays). The operand is a LENGTH, never a field value — a non-negative integer or a comparison object over the comparison subset ($eq/$ne/$gt/$gte/$lt/$lte); field pipelines and glob conversion never touch it (new 'size' coercion class). Deliberately richer than raw Mongo's `$size` (exact-only, array-only, missing never matches): MongoDriver translates to a runtime-typed `$expr` ($isArray → $size, string → $strLenCP, else 0 — note $expr predicates don't use plain indexes); PG translates to SQL (`COALESCE(jsonb_array_length|char_length, 0)`); redis evaluates client-side. Guardrails, all loud: array/String fields only (`"user" is User`), sole key of its operator object, never inside `$not` (flip the comparison), never dotted (`'a.b': { $size }` → write the nested form) and never inside an embedded-ARRAY where — drivers would measure the wrong value there; the nested RELATION spelling (`{ tags: { name: { $size: 4 } } }`) works, because the planner/join re-roots it as a top-level query on the related model.

## v0.16.5
  - **Boundary validation of where FIELD NAMES** (`Vocabulary.validate` now takes the parsed model): every field key in a where clause must resolve against the model — at every depth, through dotted paths, into relation/embedded nested wheres, inside compound branches. Numeric segments (array indices) pass; a scalar leaf (custom object scalars, AutoGraphMixed) makes deeper content opaque; `flags({ native })` remains the sanctioned escape for raw storage keys. This replaces the schema integrity the typed GraphQL where-inputs used to provide — and strictly exceeds it: the old typed inputs guarded only remote callers, while the domain→data key-walk silently DROPPED unknown keys, so a local `.where({ emialAddress: 'x' })` deleted its predicate and matched EVERYTHING. Now every caller, both sides of the wire, gets the same loud rejection naming the model and its declared fields. BEHAVIOR CHANGE: wheres carrying undeclared keys now throw instead of silently matching all/nothing — audit callers or use `flags({ native })`.
  - **The `_` vocabulary slot on every generated where-input** — the full where vocabulary now crosses GraphQL, backward-compatibly. The typed `<Model>InputWhere` stays exactly as it was (external clients hard-code its name in variable declarations; its fields are what introspection documents) and gains ONE optional member, `_: AutoGraphMixed`, carrying the where IR the type system structurally cannot express: `$` is not a legal GraphQL field name (so `$and`/`$or`/`$exists` can never be typed input fields — `Field "$exists" is not defined by type "ContactTagInputWhere"`, measured live), and a relation operand is bare-id | array | operator-object | nested-where, which input types can't union. The generated resolvers lift the slot into an implicit AND with its typed siblings (`Vocabulary.liftMixed` — model-guided, recursive: every nested InputWhere has its own slot; a literal `_` inside a Mixed scalar's data is never mistaken for it), and the query boundary validates its content like any other where. `Query.toGQL()` always serializes through the slot under the typed `$where: <Model>InputWhere` declaration. `_` is reserved: a model declaring a field by that name is refused at parse. Subscription filter inputs carry the slot too. `<Model>InputSort` is unchanged and slot-free — sort's grammar is purely navigational. NOTE: slot content must travel as a GraphQL VARIABLE (`$`-keys are illegal in document literals too).
  - `.meta()` crosses the wire: `Query.toGQL()` now serializes `query.args.meta` as the generated mutation's `meta` argument (create/update/delete), typed by the model's `@model(meta: <Type>)` declaration; offered on a model with no declaration it refuses by name (the mutation has no argument to carry it) rather than silently dropping domain semantics. (Server-side plumbing already existed: the generated resolver's `.args(args)` routes `meta` back into `query.meta`.) Note: declaring `meta` changes NOTHING about the create input's requiredness — meta is an untyped escape hatch and promises nothing about who fills the input; a wholly server-driven create (clone) belongs to a custom operation.

## v0.16.4
  - Generated `InputCreate`: a required field carrying an `instruct` pipeline is now OPTIONAL in the input type (same treatment `@field(default:)` already had) — the pipeline is the server's promise to fill it, and typing it `!` made GraphQL variable coercion refuse the mutation before any pipeline could run, so a remote client could never create the document. Storage stays guarded: the `required` validate rule still refuses a create the pipeline could not fill.

## v0.16.3
  - `Query.toGQL()` selection contract: the wire selection now matches the shape the LOCAL resolver returns (the stored document)
    - a relation selects `{ pkField }` only (not the related model's scalars; pkField honors `@model(pk:)`) — a remote client flattens it back to a bare FK
    - a connection-marked relation (`@field(connection: true)`) rides the generated Connection shape `{ edges { node { pk } } }` — previously serialized as a plain object selection, which the generated API rejects
    - enums are selected like scalars (previously dropped from every selection)
    - embedded types expand in full, recursively (previously one level of scalars), cycle-guarded
    - virtual (`@link`) fields are omitted from the DEFAULT selection (they are not stored); naming one in `.select()` opts it in, still pk-only
    - explicitness is read from `query.args.select` (the `.select()` method records it there) since QueryBuilder defaults `query.select` to every field name

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
