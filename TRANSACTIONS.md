# Transactions: Reintroduction Plan

Status: **implemented** on `release/0.16` (`TransactionScope.js`, `Resolver.js`, `QueryResolver.js`,
`Query.js`, `MongoDriver.js`, `PostgresDriver.js`). No legacy transaction code was ported —
`Transaction.js`/`QueryResolverTransaction.js` from `0.15` were deleted outright (confirmed
orphaned, nothing else referenced them). Primary/reference driver: **MongoDB**; a real
`PostgresDriver` (against `pg-mem` in tests) validated the design against a second driver mid-way
through. Verified against the full `autograph` suite (142/142), `mongo-driver`'s integration suite
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
- The request/response lifecycle should arguably be transactional too — this is the part that
  **does** need an opt-in gate (`autoTransaction`, §4.4), because unlike RI/`*Many`, autograph does
  not itself know when a whole GraphQL request ends.
- Manual `resolver.transaction()` / `.withTransaction()` / `.commit()` / `.rollback()` remains as an
  explicit "break out into my own transaction" escape hatch for consumers, independent of
  `autoTransaction` — and is the *same* API the internal RI/`*Many` auto-wrap uses (§4.5).
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
  eager;                       // if true, reads bind a session too, not just writes — see §4.6
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

  // Non-claiming lookup for reads that shouldn't trigger a new session — see §4.6.
  peekSession(client) { return this.#entries.get(client)?.handle.session ?? this.parent?.peekSession(client); }

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
  target.#transactionScope = new TransactionScope({ parent: coupled ? parent : null, independent: !coupled, eager: true });
  return target;
}
```

`resolve(query)` reads `this.#transactionScope` directly — no ambient lookup, no fallback chain.
It is safe to read *because* it is a field set exactly once (either by `autoTransaction` at
construction, or by a single `.transaction()` call on that exact reference) and never mutated
again after that. Nested/cascading calls — RI cascade steps, batch elements, hook-triggered
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

### 4.4 `autoTransaction` — the opt-in gate for the *whole request*

```js
new Resolver({ schema, context, autoTransaction: true })
```

This flag governs one thing only: whether every operation in the request — including a lone
`createOne` with no RI rules, and reads that precede it — shares a single transaction. It does
**not** govern RI or `*Many` atomicity; those are unconditional regardless of this flag (§4.5).

- **`autoTransaction: true`** — the resolver constructs its own `#transactionScope` immediately at
  construction (`eager: false` — see §4.6). This is cheap: a plain JS object, no driver call, no
  session. Every `.match()` call through *this exact resolver reference* (which spans the whole
  request, per existing `context.autograph.resolver` wiring) resolves to this scope.
  - **Reads never bind a session** in this mode — only `peekSession` (reuse one a prior write
    already bound), never `getSession` (bind a new one). A read-only request stays entirely free.
  - **The first mutation dispatched against the scope calls `scope.getSession()`**, lazily opening
    the real transaction. There is no per-operation classification beyond "is this a write" — a
    plain single `createOne`, an RI cascade step, and a batch element are all treated identically.
  - **Read-only requests are entirely free; any request that writes at all pays for exactly one
    transaction, no matter how many writes it contains.**
- **`autoTransaction: false` (default)** — no request-level `#transactionScope` is created. A lone
  `createOne` with no RI rules runs exactly as it does with no transactions at all. RI cascades and
  `*Many` batch ops are **still** atomic (§4.5) — this flag only controls whether that atomicity
  gets extended to *everything else* in the request too.
- Left deliberately opt-in (not opt-out): `Resolver` is used in contexts with no "end of request"
  to hook — migration scripts, admin tools, REPL sessions, background jobs. Defaulting this to
  `true` would silently bind those to a transaction with no host ever positioned to call
  `commit()`, relying entirely on the driver's own transaction timeout to abort long-running
  scripts partway through.
- Per-source capability is still respected underneath: `scope.getSession()` still checks
  `dataSource.supports.includes('transactions')` for the specific client involved and falls back to
  a no-op stub for sources that don't support it. `autoTransaction: true` expresses *intent*; it
  does not force capability a given source doesn't have.

### 4.5 RI and `*Many`: always-on, unconditional, self-contained transactions — via the *same* public API a manual caller uses

Unlike the whole request, RI cascades and `*Many` batch operations are **self-contained**:
autograph's own code is both the definitive opener and the definitive closer of that unit of work.
Because of that, these two call sites can unconditionally do what a manual `resolver.withTransaction()`
does, regardless of `autoTransaction` — and, critically, **it is the literal same public method**,
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

- **Nothing ambient** (`autoTransaction` off, no manual transaction open) → `parent` is `null`,
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

### 4.6 Manual `transaction()` / `withTransaction()` / `commit()` / `rollback()` — and eager vs. lazy scopes

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

**Eager vs. lazy scopes (`TransactionScope.eager`).** Every scope created via `.transaction()`/
`.withTransaction()` — manual or the internal RI/`*Many` auto-wrap — is `eager: true`: it binds a
real session on its *first operation, read or write*, not just its first write. This is
deliberately different from `autoTransaction`'s implicit whole-request root scope, which stays
lazy/`eager: false` (reads only `peekSession`, never trigger a bind). The reasoning: an explicit
`.transaction()` call is the caller asking for a real transactional unit — the same way `BEGIN` in
any database starts a real transaction whether or not you end up writing — so it should get real,
snapshot-isolated reads for its whole lifetime, not just read-your-own-writes bolted onto whatever
a write happened to bind. `autoTransaction`'s root scope stays lazy specifically so a read-only
*request* costs nothing, which is a different, narrower goal than "give my explicit transaction
real isolation." This also incidentally closes a correctness gap in `*Many`'s find-then-update
pattern: the `#find()` that locates target documents now runs inside the same transaction as the
writes that follow it, instead of outside it — closing a race where the target set and the actual
writes could see different states of the data. See §4.10 for the concrete bug this fixed.

### 4.7 Host integration contract — explicit `commit()`/`rollback()`, not a timing heuristic

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
testing and fail under real production latency. This applies specifically to `autoTransaction`'s
whole-request scope — it does not apply to RI/`*Many` (§4.5), which never had this problem because
AG itself always knows their end.

**The reliable signal already exists — outside autograph, not inside it.** The host wrapping
GraphQL execution (Apollo Server, Express, etc.) knows deterministically when a request is
finished. Autograph's job is to expose a contract, not guess:

- `resolver.commit()` / `resolver.rollback()` delegate to the resolver's own `#transactionScope`
  (no-op, cheaply, if `autoTransaction` was never enabled or no session was ever bound — the common
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
(`TransactionScope#peekSession`/`getSession`), not by which DataLoader instance served it. `#docClasses`
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
   with `TransactionScope#peekSession` plus session-aware cache keying (§4.9 #3).
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

## 5. 100,000-foot overview: what happens automatically, session by session

Walking the actual lifecycle end to end, in order:

1. **`new Resolver({ schema, context, autoTransaction })`** — if `autoTransaction: true`, constructs
   its own `#transactionScope` immediately (`eager: false`; cheap — a plain object, no driver call,
   no session). If `false` (default), no request-level scope exists yet — RI/`*Many` can still open
   their own on demand (§4.5).

2. **A read-only field resolves**, calling `resolver.match(Model)....many()`. `resolve()` reads
   `this.#transactionScope` directly (or `undefined` if `autoTransaction` is off). Either way, no
   write has occurred, so at most `peekSession` is consulted — no session ever binds. No cost.

3. **A lone `createOne` with no RI rules dispatches.** If `autoTransaction` is on, it binds
   `#transactionScope`'s session (§4.4) — the first write in the request. If off and nothing else
   is ambient, it runs exactly as with no transactions at all: no scope, no session.

4. **A `createMany`/`updateMany`/etc., or any mutation on a model with RI rules, dispatches.**
   Regardless of `autoTransaction`, this always calls `this.#resolver.withTransaction(fn)` (§4.5) —
   the *same public method* a manual caller would use — joining whatever's ambient on `this.#resolver`
   (a request-level `#transactionScope`, if `autoTransaction` is on) or opening its own top-level,
   `eager` scope (if nothing is ambient), and commits/rolls back that scope itself when its own
   bounded work settles.

5. **Every operation inside that bounded call** — batch elements, RI cascade continuation, sibling
   `postMutation` hooks firing via `Promise.all` (each getting their own clone via `.withTransaction()`,
   §4.2) — funnels its physical driver call through `scope.enqueue()`. Logically parallel,
   physically one-at-a-time.

6. **A manual transaction**, if a resolver explicitly calls `resolver.transaction()`/`.withTransaction()`:
   returns/passes a *cloned* resolver (`txn`) whose `#transactionScope` is set once, directly, no
   ambient lookup. `txn`'s own reads bind a real session on their *first* use (`eager: true`, §4.6),
   giving it genuine snapshot isolation for its whole lifetime, unlike `autoTransaction`'s lazy root.

7. **The request finishes.** If `autoTransaction` is on, the host calls `resolver.commit()` in a
   deterministic completion hook (`willSendResponse`, or a `finally` block). If off, there's nothing
   for the host to call — RI/`*Many` already closed their own scopes as they went.

8. **When, if ever, will there be a genuinely nested transaction (partial rollback of an inner unit
   while the outer one survives)?** **Never, on MongoDB or the current Postgres driver.** MongoDB
   has no savepoint primitive at any server or driver version — a permanent ceiling of the engine.
   What this design calls "nested" is always the coupled/shared-session/shared-fate model in steps
   4–6. A true nested transaction is only possible if a *different* driver advertises that
   relationship by handing back a distinct session object from `client.transaction(parentHandle)`.

## 6. Open questions for review

- Should `autoTransaction` also be settable as a schema-level/app-level default so individual
  `new Resolver()` call sites don't need to repeat it, with the constructor option as an override?
  Recommendation: yes, but this is an integration-ergonomics detail, decide during rollout.
- Should autograph ship an official Apollo Server plugin wrapping the `commit()`/`rollback()`
  contract (§4.7)? Recommendation: document first, ship a plugin once the core mechanism is proven
  in a real deployment.
- Should a scope expose an explicit "settled" state and throw a clear, AG-level error if
  `getSession()`/`enqueue()` is called against it afterward, rather than letting a stale coupled
  write hit an already-ended session directly? Still open — worth adding as a robustness item.

## 7. Implementation notes (historical — the phased plan this replaced is complete)

The original phased plan (build `TransactionScope`, cut over `Resolver`, wire drivers, implement
RI/`*Many`, `autoTransaction`, the manual API, host integration docs, and a load/race test) is done.
What actually took the most iteration wasn't any single phase — it was the sequence of design
questions in the status header above, each surfaced by testing the previous answer against real
behavior rather than reasoning about it in the abstract: ambient propagation → explicit
reference-threading → shared DataLoaders → eager scopes. Future work in this area should expect the
same pattern: a plausible-sounding mechanism can pass every test you already have and still be
wrong in a way only a new test (or a pointed question about *why* it works) will surface.
