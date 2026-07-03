# Transactions: Reintroduction Plan

Status: **implemented** on `release/0.16` (`TransactionScope.js`, `Resolver.js`, `QueryResolver.js`,
`Query.js`, `OperationScope.js`, `MongoDriver.js`, `PostgresDriver.js`). No legacy transaction code
was ported — `Transaction.js`/`QueryResolverTransaction.js` from `0.15` were deleted outright
(confirmed orphaned, nothing else referenced them). Primary/reference driver: **MongoDB**; a real
`PostgresDriver` (against `pg-mem` in tests) validated the design against a second driver mid-way
through. Verified against the full `autograph` suite (206/206), `mongo-driver`'s integration suite
(93/94 — 1 unrelated pre-existing skip), and `postgres-driver`'s (92/94 — 1 known `pg-mem`
limitation, §4.10).

**The mechanism went through a real architectural revision after initial implementation.** The
first version propagated the ambient transaction via `AsyncLocalStorage` (§4.2 originally). A
direct question — "does AG manage its own transactions the same way an end user would?" — exposed
that it didn't: the internal RI/`*Many` auto-wrap built a raw `TransactionScope` + `ALS.run()`
directly, bypassing the public `resolver.transaction()`/`.commit()`/`.rollback()` API entirely.
Chasing that down led to removing `AsyncLocalStorage` altogether in favor of plain, explicit
reference-threading (§4.2, current) — matching how `resolver.match()` itself has always worked:
always through a reference you hold, never a hidden global. That in turn surfaced that per-clone
DataLoader caches were fighting the "DataLoaders live for the request, not the transaction"
principle the framework was already built on, which led to sharing DataLoaders across a resolver
and every transaction cloned from it (§4.9), which in turn surfaced a design fork on whether
reads inside an explicit transaction should get real snapshot isolation (§4.6, "eager" scopes) —
resolved in favor of yes, matching how a real database transaction behaves. See §4.10 for the
concrete bugs each of these steps caught.

Any future driver that supports true nested transactions (e.g. Postgres `SAVEPOINT`) is a secondary
concern this design leaves room for, but is not assumed or required to exist — the current
`PostgresDriver` does not implement real nested transactions; it decomposes exactly like Mongo does.

## 1. Requirements

- Referential integrity (cascade/nullify/restrict) must run inside a transaction — **always true,
  unconditionally.** This is the one place autograph is deliberately opinionated, the same way
  pre-0.15 releases were, because AG itself is both the opener and the definitive closer of that
  unit of work (§4.5).
- `*Many` batch operations (`createMany`/`updateMany`/`pushMany`/`pullMany`/`spliceMany`/`deleteMany`)
  get the same unconditional atomicity, for the same reason (§4.5). A single-document op with no RI
  rules stays unwrapped — already atomic on its own, no transaction needed (§4.5).
- Every **gqlMutation** (root Mutation field — the transport entry point) is its own unit of
  work: the field's write and its participant hooks share one transaction, opened and closed
  in-band by autograph (§4.17). A caller who composed `mutation { a, b, c }` as ONE unit says so
  with `mutation @transaction { ... }`, escalating the granularity from field to operation —
  caller-opted because cross-field atomicity changes the caller's response/retry contract.
  **agMutations** (`resolver.match().save()/...` — the data layer) only ever JOIN an ambient
  scope, never create one; RI/`*Many` ensure their own bounded units regardless (§4.5).
- Manual `resolver.transaction()` / `.withTransaction()` / `.commit()` / `.rollback()` remains as an
  explicit "break out into my own transaction" escape hatch for consumers, independent of any
  ambient scope — and is the *same* API the internal RI/`*Many` auto-wrap uses (§4.5).
- Event-driven (`postMutation`, etc.) callbacks that trigger further mutations must be logically
  grouped under the transaction that triggered them — not orphaned onto their own session.
- Sibling/parallel event handlers (`Promise.all` in `Emitter.emit`) share one resolver instance and
  are in a **race** if that instance's own transaction state is mutated directly — each must get
  its own scope without corrupting the others' (§4.2's cloning discipline, not ambient propagation).
- Transaction semantics must be **honest about what MongoDB can actually do** — autograph must not
  pretend to offer nesting the engine doesn't support, and must not guess at "end of request" with
  timing heuristics (§4.7 explains why that was considered and rejected).

## 2. MongoDB's actual constraint (read this before anything else)

Two separate limitations, often conflated — they are not the same problem and don't have the same
fix:

1. **No nested/savepoint transactions, ever.** A MongoDB `ClientSession` supports exactly one
   active transaction. There is no primitive for "roll back just the inner part while the outer
   transaction stays alive" — no savepoints, at any server version, in any driver. This is a hard
   architectural ceiling, not a v1 gap to close later. **A "child session" does not exist on
   MongoDB.** When one logical unit of work is nested under another, there is only ever one
   physical session in play — the "child" either reuses that exact session object, or it doesn't
   participate in the same transaction at all.
2. **No concurrent operations against one session.** Separately, a session's operations must run
   strictly one-at-a-time — the driver does not support (and will reject or misbehave on)
   concurrent calls sharing a session. This part *is* just an engineering/coordination problem and
   is fully solvable with a serialization queue (§4.3).

### Autograph stays out of this decision entirely

Autograph must not encode "Mongo can't nest" anywhere in its own core logic — that would make the
framework opinionated about a specific driver, exactly what it must avoid. Instead:

- `TransactionScope` always structurally offers a parent handle to the driver:
  `client.transaction(parentHandle)`, unconditionally, whenever a parent scope exists.
- **What comes back decides everything, and it's decided entirely by identity, not by asking
  "does this driver support nesting."** `MongoDriver.transaction(parentHandle)` and
  `PostgresDriver.transaction(parentHandle)` both know they can't nest, so they simply return
  `parentHandle` unchanged — that decomposition happens entirely inside the driver. A hypothetical
  savepoint-capable driver would instead return a distinct handle.
- `TransactionScope` reacts generically: `const coupled = handle === parentHandle;`. If coupled,
  this scope's `commit()` is a true no-op and its `rollback()` propagates to the parent (there is
  nothing partial to undo). If not coupled, commit/rollback act on the distinct handle directly.
  **This single rule works for Mongo/Postgres's decomposition and a savepoint-capable driver's real
  nesting without autograph ever knowing which one it's talking to.**

## 3. Why the old (pre-0.15) stack-based approach broke

The old `Resolver.#sessions` design conflated three unrelated jobs in one mutable array, addressed
by **array position** rather than by object identity:

1. Tracking which driver session(s) belong to the current unit of work.
2. Tracking cache-invalidation callbacks ("thunks") to run once that work settles.
3. Faking nested-transaction semantics that Mongo doesn't actually provide.

Concretely: auto-wrapped multi-doc mutations deliberately shared one resolver instance across
sibling operations (non-isolated), so two *logically unrelated* concurrent writes could each push
an entry onto the *same* `#sessions` array. `commit()`/`rollback()` always operated on
`#sessions.pop()` — "whatever is currently on top" — with no check that the popped entry was
actually the one the caller had pushed. Once two pushes interleaved and their commits resolved in
a different order than they were pushed (routine under real concurrency), a commit call would pop
and close *someone else's* session — orphaning one, double-closing another — which is the direct
mechanism behind the observed `MongoExpiredSessionError` failures.

On top of that, the "hybrid transaction" object tried to approximate nesting by making its
`commit()` a no-op (defer to whatever's beneath it on the stack) while its `rollback()` was real
and immediate — an implicit, unstated admission that true nesting wasn't achievable, without ever
confronting §2's reality directly. Nested scopes also shared the exact same `thunks` array *by
reference*, so a cascading hook that opened another nested wrap underneath an already-nested one
could recursively re-drain/re-append to a queue that was simultaneously mid-drain — the mechanism
behind the observed stack overflow.

Every failure traces back to the same root cause: **shared mutable state, addressed by position,
with no per-logical-unit identity.** The redesign fixes this with identity-based scopes (§4.1) and
explicit, per-call reference discipline (§4.2) — never a shared mutable field on a resolver
instance that concurrent siblings could stomp on.

## 4. Architecture

### 4.1 `TransactionScope` — identity, not position, per data source

```js
class TransactionScope {
  parent;                      // parent TransactionScope | null — logical nesting only, see §2
  independent;                 // if true, never offers `parent`'s handle to the driver at all
  #pending = new Map();        // client -> Promise<Entry>, claimed SYNCHRONOUSLY — see #claim
  #entries = new Map();        // client -> Entry ({ handle, coupled, queue }), populated once claimed
  #settled = [];               // callbacks deferred until this client's session truly, finally seals

  static tagSession(session) { /* stable, JSON-safe id for a session — see §4.9 */ }

  #claim(client) {
    // Claims the client's entry with the IN-FLIGHT PROMISE, synchronously, before anything is
    // awaited — many concurrent callers (e.g. a *Many batch firing N .save() calls via
    // Promise.all) can ask for the same client's session in the same tick; without claiming
    // synchronously, each would see "no entry yet" and open its own separate, independently-
    // committed transaction. See §4.10 #1.
    if (!this.#pending.has(client)) {
      this.#pending.set(client, (async () => {
        const parentHandle = (this.parent && !this.independent) ? await this.parent.#getHandle(client) : undefined;
        const handle = await client.transaction(parentHandle);      // driver decides what comes back
        const entry = { handle, coupled: handle === parentHandle, queue: Promise.resolve() };
        this.#entries.set(client, entry);
        return entry;
      })());
    }
    return this.#pending.get(client);
  }

  async getSession(client) { return (await this.#claim(client)).handle.session; }

  enqueue(client, fn) { /* serializes physical calls per client; coupled delegates to parent's queue */ }
  addSettled(client, fn) { /* defers fn until this client's session truly seals; coupled forwards to parent — see §4.9 */ }

  async commit() { /* drains queues (allSettled — §4.10 #2), commits non-coupled handles, runs #settled */ }
  async rollback() { /* drains queues, propagates to parent if any client is coupled, rolls back non-coupled handles, runs #settled */ }
}
```

Two things worth calling out explicitly:

- **Sessions are tracked per data-source client, not as a single field.** A schema can span
  multiple `@model(source:)` targets, and a single scope — especially an RI cascade walking across
  models on different sources — can end up **coupled for one client and independently-sessioned
  for another**, in the same scope, simultaneously. `commit()`/`rollback()` handle this correctly
  by filtering per-entry, not by asking one global "am I coupled" question.
- `independent` is the explicit user-facing override (§4.6) for "I don't want whatever relationship
  the driver would give me — start a wholly separate transaction regardless." Absent that override,
  the default path always offers the parent and lets the driver decide (§2).

### 4.2 Propagation — explicit reference-threading, not `AsyncLocalStorage`

**This was `AsyncLocalStorage`-based in the first implementation. It was removed.** The original
reasoning: sibling `postMutation` hooks share one resolver instance (`event.resolver`), so ambient
("ask what's currently active") ALS propagation seemed like the only way to give each concurrent
auto-wrap the right scope without them stomping on each other.

That reasoning was wrong about *why* the old design broke (§3). The bug was never "no ambient
propagation" — it was "mutating a *shared* resolver instance's transaction state under
concurrency." The actual fix is simpler: **never mutate a shared resolver's own scope field —
always clone first.** `resolver.clone()` produces a fresh `Resolver` instance with its own,
never-shared `#transactionScope` field; two sibling auto-wraps sharing `event.resolver` each get
their own clone via `resolver.transaction()`/`.withTransaction()`, so there is no shared mutable
state to race on, without any ambient-context mechanism at all:

```js
// Resolver.js
transaction({ isolated = true, coupled = true } = {}) {
  const parent = this.#transactionScope;                 // read directly off THIS reference
  const target = isolated ? this.clone() : this;          // clone => no shared state with `this`
  target.#transactionScope = new TransactionScope({ parent: coupled ? parent : null, independent: !coupled });
  return target;
}
```

`resolve(query)` reads `this.#transactionScope` directly — no ambient lookup, no fallback chain.
It is safe to read *because* it is a field set by exactly one mechanism at a time (a single
`.transaction()` call on that exact reference — an isolated clone's own scope, or a host's
in-place `{ isolated: false }` scope, §4.4). Nested/cascading calls — RI cascade steps, batch elements, hook-triggered
mutations — all correctly resolve the right scope because `event.resolver` in every one of AG's
own internal event objects (`#createSystemEvent`'s `event = { ..., resolver: this, ... }`) is
*always* whichever resolver instance's own `.resolve()` is currently executing — so as long as
code follows the reference it was actually handed (the `txn` returned by `.transaction()`, or
`event.resolver` inside a hook) rather than reaching for some other resolver variable, the correct
scope is found by construction, with zero coordination machinery.

The one place this requires discipline: internal call sites (`QueryResolver`'s RI/`*Many` wrap,
`#find`/`#get`) must thread the *specific* resolver reference (`txn`, passed as an argument)
through their own helper methods, rather than defaulting to `this.#resolver` when a more specific
transactional reference is in scope. See §4.5.

### 4.3 Serialization, not parallelism, at the physical layer

Two sibling `postMutation` hooks that happen to resolve to the *same* `TransactionScope` (because
they're coupled into the same ambient transaction) each call `resolver.match(Other).save(...)`.
Both writes are logically concurrent (fired via `Promise.all`) but physically serialized through
that scope's `enqueue()` queue — satisfying Mongo's "one operation at a time per session" rule
without the caller having to know or care. Order between siblings is whatever order they happened
to enqueue in; autograph does not attempt to impose a deterministic order beyond that.

**Reads too, not just writes.** The first implementation only serialized mutations; sessioned
*reads* (DataLoader dispatches, `*Many` pre-image `#get`s, FK-validation reads, merged-`$in`
chunk fan-outs) bypassed the queue and could race an in-flight write on the same session — an
intermittent, latency-dependent violation of the driver contract that an in-memory test server
never exhibits. Fixed with `TransactionScope.run(session, fn)`, a static front door backed by a
session → owning-scope registry (populated at claim time, `WeakMap`-keyed so it dies with the
session): **every** physical driver call that carries a session — the mutation dispatch in
`Resolver#resolve` and all three execute sites in `DataLoader` — now funnels through the owner's
queue. Sessionless calls (or a caller-provided session no scope knows about) pass straight
through with no overhead. The DataLoader batch-merge fingerprint already includes the session tag,
so a merged cluster is uniformly one-session (or none) by construction, and its chunked `$in`
sub-queries serialize through the same queue instead of running `Promise.all`-parallel against
one session.

### 4.4 The host escape hatch — `transaction({ isolated: false })` on the request resolver

> **History:** this section originally described a constructor flag (`new Resolver({
> autoTransaction: true })`), then its successor `enableAutoTransaction()` — a LAZY in-place root
> scope (reads never bound a session; `TransactionScope.eager`/`peekSession` existed to support
> it). Both are **removed**: the operation scope (§4.17) covers the real use case in-band, and
> once the wrapper stopped needing the lazy primitive, the entire lazy/eager split was carrying
> its weight for one niche consumer. Every scope now binds a session on its first operation, read
> or write.

```js
const requestResolver = new Resolver({ schema, context }).transaction({ isolated: false });
```

A host that autograph's in-band demarcation can't reach — one that assembles its own executable
schema, bypassing `Schema#toObject()`'s operation-scope wrap — scopes the whole request in place
this way. Every `.match()` call through this reference from that point forward resolves to this
scope; agMutations join it ambiently; the operation-scope wrapper (if any of AG's wrapped
resolvers do run) stands down when it finds the open scope.

- **Whoever opens the scope owns its settle** — the host must call
  `resolver.commit()`/`.rollback()` at a deterministic completion point (§4.7's contract).
- **The scope is eager**: its first operation — read or write — binds the session, so the whole
  request gets one snapshot-isolated view. (The removed lazy variant kept read-only requests
  free; a host wanting that back gates the `transaction()` call on the operation being a
  mutation, e.g. from Apollo's `didResolveOperation`.)
- It does **not** govern RI or `*Many` atomicity; those are unconditional regardless (§4.5). A
  script/REPL/background-job `Resolver` with no scope runs a lone `createOne` exactly as if no
  transactions existed — the "uncarried write" semantics of §4.15 now live almost exclusively in
  that non-GraphQL territory, since every gqlMutation is carried by its field's own scope (§4.17).
- Per-source capability is still respected underneath: `scope.getSession()` still checks
  `dataSource.supports.includes('transactions')` for the specific client involved and falls back to
  a no-op stub for sources that don't support it. A scope expresses *intent*; it does not force
  capability a given source doesn't have.

### 4.5 RI and `*Many`: always-on, unconditional, self-contained transactions — via the *same* public API a manual caller uses

Unlike the whole request, RI cascades and `*Many` batch operations are **self-contained**:
autograph's own code is both the definitive opener and the definitive closer of that unit of work.
Because of that, these two call sites can unconditionally do what a manual `resolver.withTransaction()`
does, regardless of any ambient scope — and, critically, **it is the literal same public method**,
not a parallel internal mechanism:

```js
// QueryResolver.js
#resolveReferentialIntegrity(doc, andThen = () => doc) {
  const run = txn => Util.promiseChain(this.#model.referentialIntegrity.map(({ model, field, isArray, path }) => () => {
    // ...cascade/nullify/restrict, all via txn.match(model)...
  })).then(() => andThen(txn));

  // Only pay for a transaction when there's an actual cascade to protect — a model with no
  // @field(onDelete:) rules deletes exactly one document, already atomic on its own.
  return this.#model.referentialIntegrity.length ? this.#resolver.withTransaction(run) : run(this.#resolver);
}
```

`*Many` cases (`createMany`/`updateMany`/etc.) follow the identical shape:
`this.#resolver.withTransaction(txn => /* fan out via txn.match(...) */)`. `Resolver.withTransaction`
always passes `{ isolated: true }` internally — for exactly the reason §4.2 discusses: this can be
triggered from code sharing a resolver instance with concurrent siblings, so it must never mutate
that shared instance's own scope; cloning is what makes that safe. This restores the pre-0.15
behavior the framework used to have for exactly these operations, and it **composes for free**
with whatever else is going on:

- **Nothing ambient** (no operation scope active, no manual transaction open) → `parent` is `null`,
  `client.transaction(undefined)` opens a genuinely new session, and this scope's `commit()`/
  `rollback()` are real. AG closes what it opened, entirely self-contained — no host involved.
- **Something already ambient** (the whole-request root scope, or a manual transaction) →
  `client.transaction(parentHandle)` hands back the *same* handle, `coupled` resolves to `true`
  automatically, and this scope's `commit()` becomes a no-op while `rollback()` propagates up.
  That's correct, not a compromise: if this batch is logically running inside a bigger transaction,
  a failure in it *should* take the bigger one down too.

**There is no case where "not knowing which one it got" produces the wrong outcome — both branches
are independently correct.** That symmetry is what makes calling `withTransaction` unconditionally
the right call, without the call site needing to know or care which branch it's in.

### 4.6 Manual `transaction()` / `withTransaction()` / `commit()` / `rollback()`

```js
resolver.transaction({ isolated = true, coupled = true } = {})
resolver.withTransaction(async (txn) => { /* ... */ }, { isolated, coupled })
```

- No ambient scope present → always starts a new, top-level scope regardless of `coupled` (there's
  nothing to relate it to).
- Ambient scope present, `coupled: true` (default) → offers the ambient scope's handle to the
  driver and accepts whatever relationship comes back. On Mongo/Postgres (today), that's always the
  same physical session — rolling back this "child" rolls back the ambient parent too, full stop,
  by construction, not by choice. This is the closest thing to "nesting" these drivers can honestly
  offer.
- Ambient scope present, `coupled: false` → does **not** offer the parent's handle to the driver at
  all; a wholly separate session is opened regardless of driver capability. Genuinely independent:
  the ambient parent's rollback does not affect it, and vice versa. This is a deliberate, explicit
  choice to sacrifice atomicity with ambient work — e.g. a `postMutation` hook writing an audit-log
  entry that shouldn't be entangled with the primary mutation's fate (§4.8).
- `isolated` (default `true`) clones the resolver — see §4.2/§4.9 for why cloning is the safety
  mechanism, and why the clone still shares the calling resolver's DataLoaders rather than
  rebuilding fresh ones.

**Is a manual breakout still susceptible to its parent rolling back?** Only if `coupled: true` (the
default) — and if so, yes, unconditionally, because there is only one physical session between
them on Mongo/Postgres today. If the caller needs independence, `coupled: false` is how they ask
for it, explicitly, up front.

**Every scope binds a session on its first operation — read or write, not just its first
write.** A transaction is the caller asking for a real transactional unit — the same way `BEGIN`
in any database starts a real transaction whether or not you end up writing — so it gets real,
snapshot-isolated reads for its whole lifetime, not just read-your-own-writes bolted onto
whatever a write happened to bind. This also closes a correctness gap in `*Many`'s
find-then-update pattern: the `#find()` that locates target documents runs inside the same
transaction as the writes that follow it — closing a race where the target set and the actual
writes could see different states of the data (§4.10). A LAZY variant (reads never bind —
`TransactionScope.eager: false` / `peekSession`) existed for the removed request-lifetime
`autoTransaction`/`enableAutoTransaction` modes and was deleted with them; §4.4 records the
history.

### 4.7 Host integration contract — explicit `commit()`/`rollback()`, not a timing heuristic

> **Scope narrowed by §4.17.** The primary auto-transaction path (the operation scope) opens AND
> closes in-band — no host contract needed. This section now applies only to a host that scopes
> the request resolver *itself* via `transaction({ isolated: false })` (§4.4 — custom schema
> assembly, custom demarcation policy). The reasoning below — why a timing heuristic can never substitute for an
> explicit completion signal — is unchanged and is also exactly why the operation scope settles
> on an in-band structural signal (the per-field wrapper's own settle; the `@transaction` hoist
> completing its last live selection), never on quiescence.

An earlier version of this design considered detecting "end of request" automatically — e.g.
scheduling a `setImmediate()` after all currently-known hooks settle and auto-committing if no new
`.match()` call showed up. **Rejected — this is unreliable in a way that produces a real,
guaranteed, intermittent correctness bug, not just an edge case.** Any custom resolver or hook that
does ordinary async work before its next write —

```js
async function resolveSomething(_, args, { autograph }) {
  await callExternalService(args); // any await at all: HTTP call, delay, hashing, anything
  return autograph.resolver.match('Thing').save(...);
}
```

— creates a real gap between "all currently-scheduled work has settled" and "the next write
actually happens." `setImmediate` cannot see through that gap; it only knows what's been scheduled
as of the current tick. Any heuristic here commits (or tears down the session) while a resolver is
still mid-flight, intermittently, in a way that's latency-dependent — it would pass in local/fast
testing and fail under real production latency. This applies specifically to a host-managed
implicit root scope — it does not apply to RI/`*Many` (§4.5), which never had this problem because
AG itself always knows their end.

**The reliable signal already exists — outside autograph, not inside it.** The host wrapping
GraphQL execution (Apollo Server, Express, etc.) knows deterministically when a request is
finished. Autograph's job is to expose a contract, not guess:

- `resolver.commit()` / `resolver.rollback()` delegate to the resolver's own `#transactionScope`
  (no-op, cheaply, if no scope was ever enabled or no session was ever bound — the common
  read-only-request case).
- The host **must** call one of these exactly once, at a point it knows for certain is the end of
  the request — e.g. Apollo's `willSendResponse`/`didEncounterErrors` plugin hooks, or a plain
  `try { await execute(...) } finally { await resolver.commit() }` wrapper.
- **Backstop, not primary mechanism:** if a host integration forgets to call `commit()`/`rollback()`,
  the driver's own native transaction timeout is what eventually releases the session — and that
  should be a loud, alertable failure (a host-integration bug), not something autograph tries to
  silently prevent by guessing.

### 4.8 When is nesting (manual, `coupled: true`) actually useful?

RI cascades and `*Many` (§4.5) are the two AG-authored exceptions to "AG never opens a scope on its
own initiative" — and even they don't *nest* on their own initiative; they just participate in
whatever's ambient, or become the top-level owner if nothing is. Every other AG-internal path
(populate/join reads, single-document writes) already just needs to *participate*, never fork.
**Deliberate nesting is purely an end-user, explicit `resolver.transaction()` demarcation**, used
when business logic — not framework logic — wants to draw a boundary: e.g. a batch-import resolver
that wants to attempt each item and locally absorb a per-item failure without aborting the whole
request's transaction, or a `postMutation` hook writing an audit-log entry that should survive (or
not poison) the primary mutation's fate via `coupled: false`.

### 4.9 DataLoader sharing and cache invalidation

**DataLoaders are shared across a resolver and every transaction cloned from it** (`Resolver.clone()`
passes `dataLoaders: this.#dataLoaders` by reference into the new instance, instead of rebuilding
fresh ones). This was a deliberate change from the first implementation, which gave every
`isolated: true` clone (i.e. every RI/`*Many` auto-wrap, and every manual transaction) its own
empty cache — correct, but wasteful: it meant every isolated transaction paid for cold cache misses
on data the calling resolver may have already fetched moments earlier, for no correctness benefit,
since transactional read visibility is governed entirely by which DB session a query uses
(`TransactionScope#getSession`), not by which DataLoader instance served it. `#docClasses`
is *not* shared, deliberately — `getDocClass()`'s `doc.$` proxy closes over the specific resolver
instance that built it (`self = this`), so `doc.$.save()` correctly re-enters through whichever
resolver actually read that doc, which matters for identity, unlike DataLoaders.

Sharing changes how cache invalidation has to work, and doing this properly required two related
fixes (§4.10 covers the bugs each one closed):

1. **`this.clear(model)` after a write already invalidates every reader immediately** — sharing
   means there's no separate "propagate to the parent resolver" step needed, unlike the first
   implementation's removed `#parentToClear` mechanism.
2. **A second clear is still needed at true settle time.** A read through the shared cache can land
   in the window between a write's immediate clear and the transaction's real, final commit —
   caching a pre-commit view that would otherwise never get invalidated once the transaction
   actually commits. `TransactionScope#addSettled(client, fn)` defers `fn` until the client's
   session is truly, finally sealed — routing per-client to whichever ancestor actually owns that
   session's fate (same coupling logic as `enqueue`), so a coupled scope's own settle-time
   callbacks correctly wait for the real owner, not fire early.
3. **The DataLoader front-door cache key must account for session identity, not just the batch-merge
   fingerprint.** Two otherwise-identical reads — one issued with a transaction's session attached,
   one without (or with a different one) — must not collapse onto the same cache entry, or a
   transactional read's result leaks into a plain read for the same query (or vice versa).
   `Query.computeCacheKey` folds in `TransactionScope.tagSession(q.options?.session)` — the same
   stable, JSON-safe tag used by the batch-merge fingerprint, never the raw session object (which
   for MongoDB has circular references that would blow up `JSON.stringify`).

### 4.10 What the tests caught that the design missed

None of these were visible from reading the design alone — every one was found by running the
tests, several by re-deriving a fix, then temporarily reverting it and confirming the regression
test actually failed against the old code before restoring it.

1. **Async initialization race.** The first draft of `TransactionScope`'s session-claiming logic
   checked `has(client)` *before* awaiting `client.transaction(...)`. Under a `*Many` batch firing
   hundreds of `.save()` calls via `Promise.all`, every call saw "no entry yet" before the first
   one's await resolved, so each one independently opened its own separate transaction — only the
   last one to overwrite the Map entry ever got committed. Fixed by claiming the client's entry
   with the in-flight *promise itself*, synchronously, before any `await` (§4.1's `#claim`).
2. **`commit()`/`rollback()` propagating a stale rejection.** Draining a session's serialization
   queue with `Promise.all` meant that if the *last* enqueued write had already failed (and its
   rejection was already handled at its own call site), `commit()`/`rollback()` would *also* reject
   with that same error. Fixed with `Promise.allSettled` — commit/rollback only need to know the
   queue has finished, not that every write in it succeeded.
3. **Reads didn't see the transaction's own uncommitted writes.** "Reads never bind a session" was
   true for *starting* one, but incomplete: a subsequent read in the same scope needs to reuse a
   session a prior write already bound, or it never sees that scope's own in-flight writes. Fixed
   with session reuse within the scope plus session-aware cache keying (§4.9 #3; the `peekSession` mechanism it landed on was later subsumed by unconditional `getSession` when the lazy machinery was removed — §4.4).
4. **A synchronous throw during query transform propagated as a thrown exception, not a rejection.**
   Dropping `async` from `Resolver.resolve()` (reasoning "nothing here is awaited") also dropped
   the implicit try/catch an `async` function wraps its body in — and `#createSystemEvent`'s
   `$query.transform(false)` runs synchronously and can throw synchronously (a misbehaving
   transformer). Restored `async` on `resolve()`.
5. **Cloning for a transaction silently, permanently hijacked `context.autograph.resolver`.**
   `Resolver`'s constructor unconditionally re-registered itself onto the context object. Since
   *every* `*Many`/RI auto-wrap clones (§4.5/§4.2), every one of those clones was also running that
   registration — repointing `context.autograph.resolver` at an orphaned clone with an empty
   DataLoader cache (pre-sharing) and an already-settled scope, for the rest of the request. Fixed
   with a `register` constructor flag, `false` for `clone()`'s use — a clone is meant to be used
   only through the explicit reference the caller holds, never discovered via context.
6. **Sharing DataLoaders (§4.9) exposed a stale-read gap the removed `#parentToClear` mechanism had
   been masking.** A read through the shared cache in the window between a write's immediate clear
   and the transaction's real commit could cache a pre-commit view with nothing to invalidate it
   afterward. Fixed with `TransactionScope#addSettled` (§4.9 #2) — a deliberately simpler
   replacement for the old per-resolver `#parentToClear` propagation, since there's only one shared
   cache to clear now, not "the parent resolver's" specifically.
7. **The DataLoader front-door cache key didn't account for session identity**, separately from the
   batch-merge fingerprint fix that already did. A read via a transactional resolver and the same
   read via a plain one computed the same `Query.toCacheKey()`, so one leaked into the other's
   cache entry. Fixed by folding a session tag into `computeCacheKey` (§4.9 #3). Caught by a test
   that initially gave a false negative for an unrelated reason — three separately-constructed
   queries used a non-deterministic ID generator (MongoDB-style `ObjectId(1)` embeds a
   timestamp + random suffix, not a pure function of its input) — fixed by using `Query#clone()` to
   hold everything but `options.session` constant across the compared queries.
8. **A read-only manual transaction had no real snapshot isolation — "isolation" was an accident of
   an orphaned cache.** Before DataLoader sharing, a transaction that never wrote anything had its
   own separate, never-invalidated cache; a read that returned `null` before some *other*
   transaction committed kept returning that stale `null` forever, coincidentally looking like
   snapshot isolation. Once caches were shared, this accident went away and a real gap was exposed:
   a read-only `.transaction()` never bound any session at all (lazy binding is write-triggered),
   so it had nothing to actually provide repeatable reads. Resolved by making explicit
   `.transaction()`/`.withTransaction()` scopes `eager` (§4.6) — bind a session on the first
   operation of any kind, not just the first write.
9. **`PostgresDriver`'s own software-emulated snapshot isolation (needed only because `pg-mem` has
   no real MVCC) had a global early-exit that broke exactly the scenario above.** `#filterPending`
   skipped all filtering whenever nothing was pending *globally*, even when the specific session
   being read through had its own `exclusions`/`postSnapshotIds` that needed to keep hiding an id
   *regardless* of whether some unrelated transaction had since committed and cleared the global
   set. Fixed by also checking the specific session's own exclusion state before taking the
   early-exit path. Driver-specific, not a core autograph bug — a real Postgres server has no need
   for any of this emulation, since it has genuine MVCC snapshot isolation natively.
10. One remaining, accepted `pg-mem`-only limitation (not fixed, not a core bug): `PostgresDriver`'s
    software rollback only reverts newly-inserted rows (`ownPendingByModel`, deleted on rollback) —
    it has no mechanism to revert an in-place UPDATE, since `pg-mem` provides no real `ROLLBACK`.
    "delete rolls back cascades when a restrict throws mid-walk" fails against `postgres-driver`
    specifically because its cascade step is a pull/update, not an insert. Real Postgres would
    handle this correctly via native `ROLLBACK`.

### 4.11 Operation mode — `enableAutoTransaction()` for a decision made *after* construction

> **Superseded by §4.17.** This section's central premise — "counting top-level mutation fields is
> transport-specific and deliberately NOT autograph's job" — turned out to be wrong: the counting
> is fully in-band (`info.operation` is spec-level GraphQL, available inside every generated
> resolver), so autograph now does it itself for `mutation @transaction { ... }` operations —
> opens the scope itself, and — the part this section could never offer — **closes it itself**,
> with no `didResolveOperation`/`willSendResponse` plugin at all. `enableAutoTransaction()`
> itself has since been REMOVED along with the whole lazy-scope machinery (§4.4) — a host that
> assembles its own executable schema (bypassing `Schema#toObject()`'s resolver wrap) now uses
> `transaction({ isolated: false })` for the same demarcation. Kept as-is below purely for the
> reasoning trail; the code samples no longer reflect the current API.

`autoTransaction` (§4.4) is a constructor-time boolean, decided once, when the resolver is built.
In the standard Apollo integration that's typically a single, static choice for every request. A
real use case surfaced this as too coarse: a caller sends one GraphQL operation with multiple
top-level mutation fields (fully spec-legal — top-level mutation fields execute serially) and wants
all-or-nothing semantics across them, without every request in the app paying for a transaction it
doesn't need.

**This does not require autograph to know anything about headers, auth, or HTTP** — the consuming
application's own context factory already decides `autoTransaction` per request today, since it
already constructs a fresh `Resolver` per request and already has the incoming request available at
that point. What was missing was a way to make the decision *later* than construction, once the
*shape of the operation itself* is known — e.g. "this operation has more than one top-level mutation
field" — which isn't available at `context()` time in most Apollo lifecycles, only after
parsing/validation.

```js
// Resolver.js
enableAutoTransaction() {
  this.#transactionScope ??= new TransactionScope(); // idempotent — no-op if already set
  return this;
}
```

A host wires this from a lifecycle point that runs after the operation is parsed but before any
resolver dispatches — Apollo Server's `didResolveOperation` is exactly that point:

```js
const { PostOperationError } = require('@coderich/autograph');

plugins: [{
  async requestDidStart() {
    return {
      async didResolveOperation({ operation, contextValue }) {
        if (operation.operation === 'mutation' && operation.selectionSet.selections.length > 1) {
          contextValue.autograph.resolver.enableAutoTransaction();
        }
      },
      async willSendResponse({ contextValue, errors }) {
        const { resolver } = contextValue.autograph;
        // Only a NON-PostOperationError is rollback-worthy. A PostOperationError means the write
        // itself already durably succeeded and only a post-write hook failed — rolling back on it
        // would violate the §4.12 invariant (a post-write hook failure must never undo a
        // successful write). GraphQL wraps thrown errors, so check originalError too.
        const fatal = errors?.some(e => !((e.originalError ?? e) instanceof PostOperationError));
        await (fatal ? resolver.rollback() : resolver.commit());
      },
    };
  },
}]
```

Deliberately **not** autograph's job: counting top-level mutation fields (or any other
transport/operation-shape heuristic) is Apollo/GraphQL-specific policy, not something the
driver-agnostic core should hardcode an opinion about. `enableAutoTransaction()` is the one piece of
surface area autograph needs to expose for a host to build that policy on top of — same relationship
as the `commit()`/`rollback()` host contract in §4.7.

Two things worth being explicit about:

- **Idempotent, not additive.** Calling it when a scope already exists (from the constructor, or an
  earlier call) is a no-op — it never discards an in-progress transaction or its already-bound
  session.
- **Not retroactive.** Calling it after something has already dispatched through this resolver does
  not cover whatever already ran — same as `autoTransaction` at construction, only operations from
  this point forward participate. In the recommended `didResolveOperation` usage this never bites,
  since that hook runs before execution begins; it would bite if called from somewhere later in a
  custom lifecycle after a resolver had already fired.

If a caller-driven variant is wanted later (e.g. a trusted, authenticated client explicitly
requesting transactional semantics for an otherwise single-mutation operation via a header), that's
a decision entirely inside the consuming application's own context factory or `didResolveOperation`
handler — same mechanism, just a different trigger condition. It should be gated behind
authentication, not exposed to arbitrary callers: every write-containing transactional request holds
a real DB session open for its duration, and a caller who can request that on demand can hold open as
many concurrent sessions as they can send requests — a resource-exhaustion vector, not just a design
nicety.

### 4.12 `PostOperationError` / `PreOperationError` — a post-write hook failure must never undo a successful write

> **Partially superseded by §4.15.** The automatic commit-anyway classification this section
> describes now applies to the *presenter* phase (`preResponse`/`postResponse`) and to writes no
> transaction carried (already durable — nothing to undo). `postMutation` — the *participant*
> phase — aborts the unit on failure as of §4.15. The narrative below is kept as the historical
> record of how the classification was derived; §4.15 explains why `postCommit`'s introduction
> changed the correct default for `postMutation` specifically.

A separate, more severe bug surfaced from asking where commit/rollback actually happen relative to
the Emitter lifecycle (§4.4/§5's ordering was never the issue — see the restated open question at
the end of this section): `postMutation`/`preResponse`/`postResponse` rejections propagated through
the exact same path as `preMutation`/write failures. Concretely, verified by temporarily reverting
each fix and confirming the regression tests fail for the right reason: (1) a single mutation whose
`postMutation` hook threw made the caller see a rejection even though the write had already
durably succeeded; (2) inside a `*Many`/RI auto-wrap, one element's `postMutation` failure rolled
back *other, unrelated elements* that had nothing wrong with them.

The fix, settled on after considering (and rejecting) two more invasive alternatives — restructuring
`#createSystemEvent` into "all pre*, then all post*" phases across a whole batch/cascade, and a
pair of explicit `AG.RollbackError`/`AG.NonFatalError` override classes for callers to throw — in
favor of the simplest one: **classify by phase, automatically, with no override needed**, since the
phase itself already tells you everything: nothing before the write can be undone without aborting
it (rollback-worthy by construction); nothing after it can be a reason to undo a write that already
succeeded (never rollback-worthy, by construction).

- `Resolver#createSystemEvent` wraps any failure from `preMutation`/`validate` in `PreOperationError`
  (symmetry only — nothing branches on this type specifically, "not a `PostOperationError`" already
  means rollback) and any failure from `postMutation`/`preResponse`/`postResponse` in
  `PostOperationError(cause, result)` — `result` is the write's already-successful value, preserved
  even though this is an error. The actual write (`thunk(tquery)`) failing propagates unwrapped —
  there's no hook to attribute it to.
- `Resolver#withTransaction`'s catch checks `instanceof PostOperationError`: commits anyway (there's
  nothing to undo) and re-throws the `PostOperationError` itself, unwrapped-to-`.data` deliberately
  avoided — this keeps the shape identical to a plain, non-`*Many` mutation's own
  `PostOperationError`, so callers get the same `.data`/`.result` regardless of which path they went
  through.
- For the `*Many` fan-out sites in `QueryResolver.js` (`createMany`/`updateMany`/etc.), a
  `settleMany` helper replaces the naive `Promise.all` with `Promise.allSettled` + partitioning: any
  non-`PostOperationError` rejection anywhere in the batch still rolls back everything (unchanged);
  only-`PostOperationError` rejections commit, aggregated into one `PostOperationError` (an
  `AggregateError` if there's more than one) carrying every element that actually succeeded. Plain
  `Promise.all` would only ever surface whichever element's rejection settled *first* — a real
  failure racing against an unrelated element's post-write failure could be masked, incorrectly
  committing a batch that had a genuine problem in it. Verified with a deliberately-constructed race
  (a real write-level failure artificially delayed past a different element's faster post-write
  failure) — this only reproduces the bug when the real failure is forced to be the *slower* one;
  pairing a `preMutation` failure with a `postMutation` failure doesn't exercise the race at all,
  since a pre-write failure is structurally always faster (it never even reaches the write).
- `#resolveReferentialIntegrity`'s cascade walk has the same risk in sequential form: it used to be
  a `Util.promiseChain` (stops at the first rejection), so a `PostOperationError` from an early
  cascade step would abort every *later* step — yet still commit (per the rule above), persisting an
  **incomplete** cascade. Rewritten as an explicit sequential loop that catches a
  `PostOperationError` per step, keeps walking, and aggregates at the end — a real failure still
  stops the walk immediately (rollback is correct there; no reason to keep going).
- `PreOperationError`/`PostOperationError` are exported from the package's public `index.js` so a
  host can `instanceof`-check them in its own error handling if it wants to (e.g. distinguishing
  "the mutation itself failed" from "the mutation succeeded, a side effect after it didn't" in a
  GraphQL error-formatting layer) — not required, since AG's own commit/rollback logic already
  handles the classification.

**A separate bug surfaced while verifying this, unrelated to transactions:** `Emitter.onModels`/
`onKeys`/`onceModels`/`onceKeys` build their own wrapper closure around a registered listener but
never set `.listener` on it — the convention `removeListener(event, originalFn)` needs to find a
wrapped listener via `l.listener === listener` (the same convention `wrapBasicMemoize`/
`wrapNextMemoize` already followed). Without it, a hook registered via `onModels`/`onKeys` could
never actually be removed by its original function reference — it silently stayed registered
forever. Fixed by setting `wrapper.listener = listener` in `#createWrapper`, matching the existing
memoize-wrapper pattern.

**The "least surprise" question this section originally left open — no event fired after the true,
final commit — is now resolved: see §4.14 (`postCommit`/`postRollback`).** `postMutation` (and
`preResponse`/`postResponse`) necessarily fire *before* the transaction commits, for both `*Many`/RI
(commit only happens after every element's *entire* lifecycle, including its own post-phase, has
run — that's what batch atomicity requires) and the operation scope (commit only happens when
the last root mutation field settles, §4.17). That ordering is not a bug and cannot be
changed: commit is *causally downstream* of `postMutation` completing, so an event that fires after
the true commit is necessarily a different event, not a re-timed `postMutation`.

### 4.13 Post-review hardening (second pass over the shipped design)

A deep review of the finished branch surfaced one genuine correctness gap and several robustness
items, all now fixed:

1. **Sessioned reads raced sessioned writes** — the serialization queue (§4.3) only covered
   mutations. Fixed with `TransactionScope.run(session, fn)` + a static session→owner registry;
   §4.3 now describes the full mechanism. This was invisible to every test suite because
   `mongodb-memory-server`'s near-zero latency never let the race materialize — exactly the
   local-vs-production gap §4.7 warns about.
2. **Settle-state** (`TransactionScope.state`): `commit()`/`rollback()` are idempotent (memoized
   settlement — a coupled child propagating rollback to a parent that a `withTransaction` wrapper
   also settles no longer double-touches driver handles); a stale *write* against a settled scope
   rejects with a clear AG-level error instead of a raw driver "session ended"; a *read* through a
   settled scope degrades to a plain sessionless read of committed state — necessary because docs
   returned from a transaction lazily resolve populated fields through the same (cloned,
   now-settled) resolver during response serialization, after the session sealed. A settled scope
   is no longer offered as a parent by `resolver.transaction()`.
3. **Settled callbacks are outcome-aware and isolated**: `addSettled(client, fn, key)` passes
   `'commit' | 'rollback'` to `fn`, dedupes by `key` (N writes to one model register one
   settle-time cache clear), runs immediately if the owner already settled, and is wrapped in
   `allSettled` so a throwing callback can never turn a successful commit into a rejected
   `commit()` promise. This is the groundwork a future `postCommit`/`postRollback` event needs.
4. **`deleteOne`'s pre-image read moved inside its RI transaction** — the cascade `where` clauses,
   restrict counts, and the delete itself now see one consistent view (the same fix §4.6 already
   gave `*Many`'s find-then-write pattern).
5. **`settleMany`'s recovery payload is positionally complete**: an element whose write committed
   but whose post-write hook failed now appears in the aggregated `PostOperationError.result`
   (aligned by input position) — previously only fully-clean elements did, so a caller reconciling
   against the database undercounted.
6. **`withTransaction` no longer masks the root cause** when `rollback()` itself also fails (e.g.
   a session the original failure already aborted server-side).
7. **`transaction({ isolated: false })` refuses to orphan an active scope** (it would have made
   the original transaction unreachable through `resolver.commit()`, leaving it to die by driver
   timeout), and a settled scope is treated as "nothing ambient" rather than offered as a parent.
8. **§4.11's recommended host plugin is `PostOperationError`-aware** — the earlier version rolled
   back on *any* GraphQL error, which under a request-spanning scope would have undone a durable write
   because a side-effect hook failed, violating §4.12's own invariant.

### 4.14 `postCommit` / `postRollback` — the durable-outcome events

`pre/postMutation` bracket the **write**; `postCommit`/`postRollback` bracket the **transaction**.
Built directly on `addSettled` (outcome-aware since §4.13 #3) — the internal mechanism this always
needed, now surfaced as ordinary Emitter events:

- **Uniform contract: `postCommit` = "this write is durable."** For a write carried by a scope,
  it fires when the *owning* session truly, finally seals — a `*Many`/RI wrap's own commit, or the
  operation scope's commit at the last root mutation field — or a host's explicit
  `resolver.commit()` under a host's in-place scope (a batch nested inside a bigger
  ambient transaction correctly waits for the *bigger* one — `addSettled`'s coupled routing). For a
  write no transaction carried, it is already durable when the driver returns, and `postCommit`
  fires at the end of that mutation's own post-phase — so in every path, `postCommit` fires after
  `postMutation`/`preResponse`/`postResponse`.
- **`postRollback` is the compensation hook** — the write succeeded but its transaction then rolled
  back. A write that itself failed emits neither (nothing durable, nothing to compensate); a
  `preMutation` short-circuit emits neither (nothing was written).
- **Granularity matches `postMutation`**: per query — one event per batch element / cascade step,
  each carrying the same `event`/`query` object its lifecycle events saw (`query.result`
  populated).
- **Fire-and-forget by construction.** There is no caller left to veto or shape anything: listener
  failures are isolated (`allSettled` in `TransactionScope#settle`; an isolated catch on the
  non-transactional path) and can never reject `commit()` or a mutation that already succeeded. A
  `postCommit` failure can only be logged by the listener itself.
- **Writes from inside these hooks are new units of work.** A basic (arity < 2) listener receives
  a DETACHED resolver (§4.18), so `event.resolver.match(...).save(...)` simply works — a fresh,
  fate-independent write, which is exactly what a durability observer's follow-up write is. A
  next-style (arity >= 2) listener still holds the ambient resolver, whose scope has settled by the
  time `postCommit` fires — its writes reject with the settled-scope error; use
  `event.resolver.transaction()` (a settled scope is not offered as a parent — §4.13 #7) for an
  explicit fresh unit.
- **Hot-path unchanged for reads**: the `#createSystemEvent` bypass only consults the two new
  listener indexes for mutations.
- A `PostOperationError` and `postCommit` compose as expected: a mutation whose presenter hook
  failed (or whose bare, uncarried write had any post-phase failure) still emits `postCommit` —
  the write itself is durable. A *participant* (`postMutation`) failure on a carried write aborts
  the unit instead (§4.15), so those emit `postRollback` — the compensation event — not
  `postCommit`.

**When to use which** (the migration rule is short and checkable): a hook belongs in `postMutation`
if it must share the mutation's fate or complete before the response — atomic follow-up writes
(audit rows, denormalized counters via `event.resolver`), shaping `query.result`. It belongs in
`postCommit` only if it is an irreversible *external* side effect — email, webhook, queue publish —
that must not announce something a rollback could still undo. Most existing hooks stay where they
are.

### 4.15 Abort-by-default — the post-phase is role-graded, and each phase's failure semantic derives from its role

§4.12's commit-anyway classification was calibrated against what `postMutation` *contained* at the
time: notifications, logging, side effects — **observers**. §4.14 gives observers a proper home
(`postCommit`), which re-sorts `postMutation`'s population down to **participants**: hooks that are
part of the unit of work itself (audit rows, denormalized counters, derived writes, deferred
invariant checks). For a participant, a failure means *the unit is incomplete* — and committing an
incomplete unit is silent corruption. So the default flipped, landing on a scheme where every
phase's failure behavior follows from its role:

| phase | role | on throw |
|---|---|---|
| `preMutation` / `validate` | gatekeeper | abort — the write never happens (`PreOperationError`) |
| `postMutation` | **participant** | **abort the unit** — propagates unwrapped, same as a write failure; if NO transaction carried the write it is already durable and physically cannot be undone, so the failure surfaces as `PostOperationError` with `.result` (honest fallback) |
| `preResponse` / `postResponse` | presenter | `PostOperationError` — data complete and committed, only presentation failed; never rollback-worthy |
| `postCommit` / `postRollback` | observer | isolated — structurally cannot affect anything |

(The "no transaction carried the write" fallback row is now nearly exclusive to non-GraphQL
usage — direct agMutations in scripts, REPLs, background jobs — since every gqlMutation is
carried by its own field scope, §4.17.)

Why abort-by-default won, in brief:

- **Every precedent agrees.** A Postgres AFTER trigger that raises aborts the transaction; Rails
  `after_save` raising rolls back the save (the tolerant hook is `after_commit`); Django and
  Hibernate are the same shape. Commit-anyway-inside-the-transaction was the exotic choice, made
  before a post-commit hook existed here.
- **Zero new API.** Abort = plain `throw` (what every trigger/ORM convention taught); tolerance =
  the hook's own `try/catch` (explicit, visible, per-hook); "failure should never abort anything" =
  the hook belongs in `postCommit`. The rejected `RollbackError` escalation class (considered when
  the default was commit-anyway) never needs to exist — both behaviors are ordinary JavaScript.
- **Fail-closed where it matters.** Under commit-anyway, forgetting an escalation mechanism on an
  integrity-critical hook silently commits an incomplete unit (an unaudited change, a drifted
  counter) — discovered at the compliance review. Under abort-by-default, the dangerous mistake is
  loud: a rolled-back batch is a retry; a silently incomplete one is corruption.
- **Nuance that falls out for free:** a `PostOperationError` *passing through* a `postMutation`
  hook (a nested mutation inside the hook that failed only its own presenter phase) stays a
  `PostOperationError` — that nested write IS complete; only its presentation failed. The type
  itself carries the correct decision through every layer.

Both of §4.12's original regression bugs remain fixed, each by its proper mechanism: (1) a bare
single mutation whose hook throws still surfaces `PostOperationError` with the durable `.result`
(the no-transaction fallback row — byte-for-byte the §4.12 behavior); (2) a side-effect hook that
must not roll back unrelated batch elements now does that by *being an observer in `postCommit`*,
where it structurally cannot — and if the failing hook was actually a participant, rolling back
the batch was correct all along.

**The 0.16 migration sentence:** move your observers to `postCommit`/`postRollback`; whatever
remains in `postMutation` will abort the transaction if it throws — which is exactly why it's
still there.

### 4.16 The three layers — and `postResponse` as the unconditional, pure response observer

The full event surface sorts into three layers, each with its own shape/observe pair and its own
failure semantics. Naming the layers dissolves the last "least surprise" question ("why do the
`*Response` events fire before commit?") — they fire before commit because they belong to the
**response** layer, and the response is assembled before the unit settles; durability has its own
observers now:

```
DB layer:         preMutation → validate → [write] → postMutation        shape/participate — abort semantics
response layer:   preResponse (shape) → postResponse (observe, ALWAYS)   PostOperationError semantics
durability layer: ⋯ commit | rollback ⋯ → postCommit | postRollback      observe — isolated
```

- `preMutation`/`validate` shape **what lands in the database**; `postMutation` participates in
  that unit of work (§4.15).
- `preResponse` shapes **what the caller is told** — the last chance to reshape the outgoing
  result. Skipped if `postMutation` already short-circuited with an explicit replacement
  (unchanged).
- `postResponse` **observes** what the caller was told. Two changes make it honest about that
  role: it now fires **unconditionally**, last, with the settled result — previously an upstream
  return-value short-circuit (from `postMutation` or `preResponse`) silenced it, so the observer
  missed exactly the responses that were reshaped — and it is a **pure observer**: its return
  value is deliberately ignored (an observer must not be able to reshape what it witnesses; treat
  `event.query.result` as read-only there). It does not fire on error paths — an errored mutation
  sends no result out the door to observe. Its failure is still a response-layer failure
  (`PostOperationError` — awaited and visible, but never rollback-worthy).
- `postCommit`/`postRollback` observe **what became durably true** (§4.14). Under a carried
  scope the two observation layers genuinely diverge: a `postResponse`-observed success can
  still be rolled back afterward (e.g. a later root field failing the operation, §4.17) — which
  is now expressible (`postRollback`) instead of surprising.

Boundary note: AG's `postResponse` is *per-query* out-the-door. The strictest "final HTTP payload,
errors included" lives one level above AG — e.g. Apollo's `willSendResponse` — and can't be an AG
event without AG knowing about transports.

Walking the actual lifecycle end to end, in order:

1. **`new Resolver({ schema, context })`** — no scope at construction, and the request resolver
   itself is NEVER scoped in place. Each gqlMutation runs against a transactional CLONE (§4.17):
   the wrapper swaps `context[namespace].resolver` to the clone for the duration of the field
   (root mutation fields are spec-serial, so assign+restore is race-free) and restores it after.
   Under `@transaction`, one clone/scope is shared by all root fields instead of one per field.

2. **A read-only field resolves**, calling `resolver.match(Model)....many()`. `resolve()` reads
   `this.#transactionScope` directly — `undefined` for a query operation (queries are never
   wrapped), so the read dispatches plain: no scope, no session, no cost. (A read through an OPEN
   scope — inside a gqlMutation's field clone, or a host's in-place scope — binds and joins that
   scope's session: a transaction's reads are part of the transaction.)

3. **A lone `createOne` with no RI rules dispatches.** Under an operation scope it binds
   `#transactionScope`'s session (§4.4) — the first write of the operation. With nothing
   ambient (a single-field operation, a script), it runs exactly as with no transactions at all:
   no scope, no session.

4. **A `createMany`/`updateMany`/etc., or any mutation on a model with RI rules, dispatches.**
   Regardless of any ambient scope, this always calls `this.#resolver.withTransaction(fn)` (§4.5) —
   the *same public method* a manual caller would use — joining whatever's ambient on `this.#resolver`
   (the ambient field/operation scope, if one is active) or opening its own top-level
   scope (if nothing is ambient), and commits/rolls back that scope itself when its own
   bounded work settles.

5. **Every operation inside that bounded call** — batch elements, RI cascade continuation, sibling
   `postMutation` hooks firing via `Promise.all` (each getting their own clone via `.withTransaction()`,
   §4.2) — funnels its physical driver call through `scope.enqueue()`. Logically parallel,
   physically one-at-a-time.

6. **A manual transaction**, if a resolver explicitly calls `resolver.transaction()`/`.withTransaction()`:
   returns/passes a *cloned* resolver (`txn`) whose `#transactionScope` is set once, directly, no
   ambient lookup. `txn`'s own reads bind a real session on their *first* use (§4.6),
   giving it genuine snapshot isolation for its whole lifetime.

7. **Each gqlMutation settles its own unit** — the wrapper awaits commit before the field
   resolves (per field by default; under `@transaction`, the FIRST field's hoist executes and
   settles the whole operation before any field returns — §4.17). AG opened it, AG closes it;
   the host calls nothing. (Only a host that opened its own scope via
   `transaction({ isolated: false })` — §4.4/§4.7 — still owns a commit call.) RI/`*Many` closed their own
   scopes as they went, and nested-selection serialization after the commit runs through the
   restored (scope-less) request resolver — plain reads of committed state; docs returned from
   the field's clone degrade the same way (§4.13).

8. **When, if ever, will there be a genuinely nested transaction (partial rollback of an inner unit
   while the outer one survives)?** **Never, on MongoDB or the current Postgres driver.** MongoDB
   has no savepoint primitive at any server or driver version — a permanent ceiling of the engine.
   What this design calls "nested" is always the coupled/shared-session/shared-fate model in steps
   4–6. A true nested transaction is only possible if a *different* driver advertises that
   relationship by handing back a distinct session object from `client.transaction(parentHandle)`.

### 4.17 The operation scope — every gqlMutation is a transaction; `@transaction` escalates it

**Vocabulary** (this section's design hinges on it): a **gqlMutation** is a root Mutation field
invocation — the transport entry point; an **agMutation** is a data-layer write
(`resolver.match().save()/push()/delete()/...`). The ownership rule: **gqlMutations OWN
transaction boundaries; agMutations only ever JOIN the scope ambient on the resolver reference
they run through (never create one); RI/`*Many` ensure their own bounded units** (§4.5). Every
scope has exactly one owner — the same "autograph only opens transactions it can definitively
close" principle, applied at the transport entry point.

`Schema#toObject()` wraps every root Mutation resolver — user-defined included, since user
precedence is applied *inside* AG's resolver merge — in the `OperationScope.js` decorator.

**Default: each gqlMutation is its own unit of work.** The wrapper runs the field through
`resolver.withTransaction()` — the literal same public API a manual caller uses — against an
isolated clone, swapping `context[namespace].resolver` to that clone for the duration of the
field and restoring it after. Root mutation fields are spec-serial, so plain assign+restore on
the shared context is race-free. Consequences:

- The field's write **and its participant hooks** share one transaction: a `postMutation` throw
  rolls the write back instead of stranding it (§4.15's "uncarried write" branch now applies
  almost exclusively to non-GraphQL usage — scripts, REPLs, background jobs). A custom
  gqlMutation doing three agMutations through `context.autograph.resolver` gets them atomic as a
  set, for free.
- The **caller-facing GraphQL contract is unchanged** — partial success across fields, data +
  errors. Fields are independent units; a failed field just no longer leaves anything half-done.
- **No countdown, no operation-shape analysis, no leak risk** in the default path: each field
  settles its own scope in its own catch, so GraphQL's non-null propagation abandoning later
  fields abandons nothing that is still open. Commit happens before the field resolves;
  nested-selection serialization then runs through the restored (scope-less) request resolver
  against committed state, and docs returned from the field's clone lazily populate via the
  settled-scope read degradation (§4.13).
- A `PostOperationError` commits the field and surfaces (same rule as `withTransaction`);
  `postCommit`/`postRollback` fire per field, at that field's own settle.
- The request resolver itself is **never scoped in place** by autograph — in-place scoping
  exists only as the host escape hatch (`transaction({ isolated: false })`, below).

**`mutation @transaction { a, b, c }`: the caller escalates the unit of work from field to
operation — and the operation executes as if it were a single resolver.** The FIRST live root
field's invocation **hoists** the entire unit: from `info.operation` it derives the ordered live
root selections (fragments flattened, `@skip`/`@include` evaluated against
`info.variableValues`, membership checked against the resolver map, same-response-key selections
deduped exactly as the executor's field merging would), then executes every one of them
sequentially — real resolver fns, arguments coerced from the document AST by graphql's own
`getArgumentValues`, sibling `info`s constructed from the executor-born
schema/operation/fragments objects with each field's own identity — against one shared
transactional clone, and **settles the transaction (commit or rollback) before returning
anything**. Subsequent field invocations are replay stubs: they return the recorded (already
durable) result or throw the recorded error at their own response path.

Hoisting is what makes the response contract below *unconditional*. The executor materializes
each field's payload into the response tree the moment its resolver returns — long before a
later field's failure exists — and nothing (no proxy, no `toJSON`, no retroactive nulling)
survives value completion to retract it. Every earlier design fought that temporal gap
(designated committers, settle-state short-circuits, non-null-propagation dependencies);
hoisting deletes the gap itself: **the unit's fate is sealed before any field materializes, so
`data` can never exhibit a rolled-back payload — regardless of field nullability.** On commit,
every field presents its real durable result (a per-field ledger); on rollback, every field
errors — executed-then-undone fields are retracted to an `OPERATION_ABORTED` error (cause
embedded in the message) and never-ran fields record the same. A mid-operation
`PostOperationError` no longer aborts anything: the hoist completes the unit and commits
(response-layer failures never abort — now unconditionally, since executor abandonment can no
longer amputate an in-flight unit).

This is the mode that diverges from GraphQL's partial-success contract, which is why it is the
caller's to request. (Directive declared in the framework typeDefs — `directive @transaction on
MUTATION`, name configurable like every other AG directive, so document validation accepts it. A
single-field `@transaction` operation degenerates naturally — a hoist of one. Abuse surface is
minimal: the operation executes server-side at server speed, bounded by document-complexity
limits.)

**The response contract — transport parity with the agMutation caller.** A rejected agMutation
tells the backend developer two facts: WHAT PHASE failed (the error's type — `PreOperationError`
/ `PostOperationError` / plain) and WHETHER THE DATA LANDED (`PostOperationError.result`,
§4.15). The wrapper translates exactly those two facts onto the outgoing error's `extensions`
(graphql-js copies `originalError.extensions` verbatim onto the response error), so the GraphQL
consumer reads the same story with no host integration:

| Extension | Meaning |
|---|---|
| `code` | `PRE_OPERATION_ERROR` \| `POST_OPERATION_ERROR` \| `MUTATION_ERROR` (the write/participant itself) \| `OPERATION_ABORTED` (this field was rolled back or never ran because a sibling's failure aborted the `@transaction` unit) |
| `committed` | The unit of work's durable fate — the settle decision the wrapper just made |

There is deliberately **no `result` extension**: response payloads only ever flow through
GraphQL completion (selection sets, custom resolvers, crud visibility). The raw doc is the
agMutation caller's channel, *behind* the trust boundary; the transport caller's channel is
`data`, and a committed-but-response-layer-failed field is `null` there (spec: an errored field
has no value) with `committed: true` on its error — refetch if you need it. Parity of intent,
not of bytes: both callers learn phase + fate, and each recovers data through their own layer.

The invariant this buys, with **no scenario-dependent readings**: a populated `data` field is
ALWAYS a real, committed result; everything else lives in `errors`, each entry self-describing.
In the default mode that holds because unit = field (a populated field committed in its own
unit, whatever happened to its siblings); under `@transaction` it holds because of hoisting
(nothing materializes until the unit's fate is sealed). Field nullability affects only *how
much* `data` says, never whether it lies: nullable custom fields give a per-field ledger
(`data.a` real, `data.b: null` + error); AG's non-null generated fields collapse any failure to
`data: null` wholesale via GraphQL's own propagation. Either way, read the errors — each one
carries its phase and fate.

**Host escape hatch.** An OPEN scope already on the request resolver (a host that called
`transaction({ isolated: false })` — custom schema assembly, custom demarcation; §4.4) means the
host owns the whole request's unit: the wrapper stands down entirely; agMutations join the
host's scope ambiently and the host calls `commit()`/`rollback()` (§4.7).

**The honest caveats.**

- **Committed sibling results can vanish from `data` under non-null fields.** Any field error
  nulls the whole tree, so a multi-field request where field `b` fails hides field `a`'s
  committed result from `data` — in the default mode `a` genuinely committed (its own unit), and
  under a committed-with-`PostOperationError` `@transaction` the whole unit did. The price of
  "`data` never lies" is that it sometimes says less than what happened; the errors say the rest
  (`committed` tells you whether a refetch will find anything).
- **Hoisted siblings run inside the first field's invocation** (`@transaction`). Per-field
  tracing/APM spans attribute the whole unit's work to the first field; a custom resolver
  receives a fabricated-but-faithful `info` (real AST `fieldNodes`, executor-born
  schema/operation/fragments, its own fieldName/returnType/path — connection detection and
  selection-tree building verified intact) rather than an executor-born one. Under non-null
  fields, a rollback surfaces at the FIRST field's response path (its replay throws before the
  executor reaches the actual culprit) — the cause is embedded in the message and classified in
  `extensions`; nullable fields report every field at its own path.
- **Sibling argument coercion is realm-sensitive** (`@transaction`): `getArgumentValues` does
  `instanceof` checks against graphql type classes, so a host running a *different* `graphql`
  package instance than AG's could make hoisted coercion throw (the dual-realm hazard
  `AppService.buildSelectionTree` deliberately avoids). Failure mode is loud, not silent — the
  throw aborts and rolls back the unit, never miscoerces a write.
- **Direct (schema-less) invocations cannot hoist** — a script calling the wrapped resolver with
  a fabricated `info` that lacks `info.schema` has nothing to coerce sibling arguments with and
  no `data` tree to keep honest; `@transaction` degrades to independent per-field units there.
- **Context restore vs. stray async work.** The wrapper restores `context[namespace].resolver`
  when the field (or hoist) settles, so un-awaited async work spawned inside a field that
  RE-READS the context resolver later sees whatever is then current. Fire-and-forget work should
  capture `event.resolver` (arity < 2 listeners get the detached twin for exactly this reason —
  §4.18), not re-read the context.
- **Hosts that assemble their own executable schema** (bypassing `Schema#toObject()`'s wrap)
  get no per-field or `@transaction` scoping — they keep the §4.7/§4.11 host-managed contract
  via `transaction({ isolated: false })`.
- **Root Mutation fields with no resolver in AG's merged map** (declared in SDL, resolved by
  something merged outside AG) are not wrapped and not part of the hoisted unit — the executor
  invokes them normally, outside the `@transaction` scope, and their agMutations through the
  (restored, scope-less) request resolver run as uncarried writes. Such resolvers should use
  `resolver.transaction()` themselves.
- **Cost.** Every gqlMutation now pays a session + commit round-trip (on MongoDB with
  `w: majority`, a real latency add per write). Deliberate: uniform participant semantics were
  judged worth it, and the known optimization — skip the scope for AG-*generated* single-write
  fields when no participant hook is listening (`Emitter.hasListenersFor`), always carry
  user-defined fields whose bodies AG can't see — is deferred until measured need.

### 4.18 Detached resolvers — arity < 2 listeners are never transaction participants

**The unit of work is exactly what the mutation awaits.** A basic-style (arity < 2) Emitter
listener is structurally incapable of being awaited — `emit()` collects its promise and
deterministically swallows its rejection (§4.13). Handing such a listener the ambient *sessioned*
resolver was a category error: participant-grade access granted to something that can never meet
the participant contract. Its writes raced the carrying transaction's settle for membership —
enqueued before settle began → inside the transaction; after → rejected, and (being
fire-and-forget) *silently dropped*. Never torn, but nondeterministic.

The Emitter now hands basic listeners an event whose `resolver` is the request's **detached twin**
(`Resolver#detach()`): no transaction scope, ever — reads are sessionless (committed state only),
writes land immediately, unconditionally, and fate-independently. Next-style (arity ≥ 2) listeners
still receive the ambient resolver and fully share the mutation's fate. That completes the
taxonomy with no leftover ambiguity:

| Listener shape | Resolver received | Writes | Failure |
|---|---|---|---|
| arity ≥ 2 (participant) | ambient | share the mutation's fate | aborts the carried unit (§4.15) |
| arity < 2 (detached observer) | detached twin | immediate, fate-independent | swallowed (§4.13) |
| `postCommit`/`postRollback` (durability observer) | per shape above | new units of work | isolated (§4.14) |

Every hook author's question — "does my write share fate / survive rollback / wait for commit?" —
is answered by which shape they wrote, not by timing.

**The two costs, stated plainly:**

- **Detached writes survive rollback.** A fire-and-forget hook's write lands even when the
  carrying transaction rolls back. For the canonical arity < 2 uses (metrics, logs, cache warm)
  that's correct or preferable; anything audit-like must be a participant (arity ≥ 2) — which was
  always the correct shape for it.
- **Detached reads can't see the open transaction's uncommitted writes** — including the very
  mutation that triggered the hook. Mostly moot: the hook already holds
  `event.query.result`/`doc`/`merged`. Re-reads of related uncommitted docs will miss.

**Mechanics worth knowing:**

- One twin per **request**, not per resolver instance — memoized by the shared DataLoaders map, so
  events fired from RI/`*Many` txn clones hand back the same twin (stable identity keeps Emitter
  memoization working).
- The twin gets **fresh DataLoaders** (the ambient shared cache can hold raw results fetched
  through an open transaction's session — uncommitted-view data a sessionless consumer must never
  be served), and every write through any resolver of the request explicitly invalidates the
  twin's cache too.
- The twin **cannot acquire a scope in place** (`transaction({ isolated: false })` throws on
  it); `.transaction()`/`.withTransaction()` still work — they scope a clone, which is the
  sanctioned way for a hook to run an explicit unit of work.
- Enforcement is convention-strength: `context.autograph.resolver` (the ambient one) remains
  reachable from any hook. `event.resolver` is the sanctioned path; going around it is opting out
  of the guarantee explicitly.
- Pleasant consequence: the old `postCommit` gotcha ("a write through `event.resolver` throws —
  its scope has settled") dissolves for the fire-and-forget form, which is what most durability
  observers are (§4.14).

## 6. Open questions for review

- ~~Should `autoTransaction` also be settable as a schema-level/app-level default...~~ Moot: the
  constructor flag is removed; the operation scope (§4.17) is caller-opted per operation via
  `@transaction` and needs no per-call-site configuration at all.
- ~~Should autograph ship an official Apollo Server plugin wrapping the `commit()`/`rollback()`
  contract (§4.7)?~~ Moot for the standard path: the operation scope (§4.17) opens AND closes
  in-band, so there is nothing for a plugin to do. Only relevant if the §4.7 host escape hatch
  sees real adoption.
- ~~Should a scope expose an explicit "settled" state...~~ Done (§4.13): `TransactionScope.state`
  (`open`/`committed`/`rolledBack`), idempotent memoized `commit()`/`rollback()`, clear AG-level
  errors on stale writes, graceful sessionless degradation for post-settle reads.
- ~~Should a `postCommit`/`postRollback` Emitter event be exposed...~~ Done (§4.14).

## 7. Implementation notes (historical — the phased plan this replaced is complete)

The original phased plan (build `TransactionScope`, cut over `Resolver`, wire drivers, implement
RI/`*Many`, `autoTransaction`, the manual API, host integration docs, and a load/race test) is done.
What actually took the most iteration wasn't any single phase — it was the sequence of design
questions in the status header above, each surfaced by testing the previous answer against real
behavior rather than reasoning about it in the abstract: ambient propagation → explicit
reference-threading → shared DataLoaders → eager scopes. Future work in this area should expect the
same pattern: a plausible-sounding mechanism can pass every test you already have and still be
wrong in a way only a new test (or a pointed question about *why* it works) will surface.
