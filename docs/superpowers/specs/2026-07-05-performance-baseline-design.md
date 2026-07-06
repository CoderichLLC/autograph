# Performance Baseline Initiative — Design Spec

**Status:** Approved direction (rev 2 — returning-writes folded into the base driver contract;
public pipeline metadata deferred to internal audits; Part 3 rebuilt around the compile-seam
principle)
**Date:** 2026-07-05
**Scope:** Three ordered workstreams that lower AG's baseline cost with ZERO public API change
and ZERO semantic change: (1) driver-call accounting + benchmark harness, (2) pre-image
elision on top of a strengthened driver contract, (3) compiled transformers.

## Doctrine

AG's baseline overhead falls into two structural taxes, each with a spirit-preserving fix:

1. **Interpretation** — every request re-walks a schema that has been static since `parse()`.
   The dispatch *structure* is already precomputed (`$model.transformers.*` shapes, pipe
   arrays, `docTransform`) — but the *execution* is still interpreted generically: per doc,
   per field, per pipe step, fresh args-object spreads through three layers. Fix: make parse
   the compile step (AJV / fast-json-stringify precedent).
2. **Provisioning** — work done to serve consumers that may not exist: the pre-image read
   serves doc-consuming pipelines, RI, and event hooks; on a model with none it is a pure
   wasted round trip. Fix: statically elide unconsumed provisioning — the schema knows at
   parse time what its pipelines consume; `Emitter.hasListenersFor` knows at request time
   whether hooks exist (the pattern `#createSystemEvent`'s hot-path bypass already proves).

### The compile-seam principle (binding on Parts 2 and 3)

**Decide at parse, dispatch blindly at runtime.** Parse installs uniform per-model function
slots; request-flow call sites always invoke the same slot with no visible branching. All
specialization — doc-free? identity fast path? which chain shape? — happens once, at parse,
by *selecting which function gets installed*. The one input that cannot be baked (listener
registration is runtime) is checked *inside* the installed function, never at the call site.

The slots are not new structure — they are the existing one, promoted:

- `$model.transformers.{create,update,where,sort,validate,toDriver}` — already installed by
  `buildDerived`. These STAY, same names, same call sites (`Query.transform`, `toDriver`,
  `QueryResolver`'s push path). What changes is what's behind them: `Transformer.config()`
  becomes the compiler — it precomputes the specialized execution plan for its shape — and
  `transform()` runs that plan. Nothing goes away; the interpreter inside is replaced.
- `$model.docTransform` — already a hand-built slot in `buildDerived` (and rebuilt for
  interface models post-aggregation — the compile must ride that same rebuild). Gains
  precomputed field partitions.
- `$model.preImage(query, resolver)` — the ONE new slot (Part 2), installed by
  `buildDerived` next to `docTransform`.

**Backend is swappable; the seam is the commitment.** Backend one is closure
specialization — no string codegen, no `eval`. If Part 1's bench later shows the
closure-compiled path still dispatch-bound, a `new Function` backend drops in behind the
identical slots without touching a call site. On-disk/build-step codegen is REJECTED: it
breaks runtime schema composition (`merge()` chains) and undoes the boot-time story
(parse IS the compile-and-validate step; "booting in CI is a full schema check" only holds
if parse is where everything happens). No dual paths survive: compiled slots *replace* the
generic walk for every model, always — there is no `if (compiled)`.

Other constraints binding on all parts:

- No public API changes. No new user-facing flags or modes in v1 (pipeline metadata is
  deferred — see Part 2).
- No semantic changes — the TestSuite passing unchanged on every driver IS the proof.
- Correctness-conservative: anything the framework can't statically prove about *custom*
  user code takes the slow path.

---

## Part 1 — Driver-call accounting + benchmark harness

Round trips are deterministic and countable; make performance a **conformance property**
before optimizing anything. Lands first because Parts 2–3 are asserted/measured by it.

### 1a. `instrumentClient` (testsuite package)

`workspace/testsuite/` exports a wrapper used by each driver package's `jest.service.js`:

```js
const { instrumentClient } = require('@coderich/autograph-db-tests');
const { client, calls } = instrumentClient(rawClient);
// calls = { total, byOp: { findOne: n, updateOne: n, ... }, reset() }
```

A thin delegating wrapper whose `execute(plan)` increments counters keyed by the op recorded
at `prepare()` time (plans are opaque — track via a WeakMap keyed by plan object, never by
mutating driver-visible fields). All other methods (`transaction`, `collection`,
`disconnect`, extras) pass through untouched. Exposed to the suite as `global.driverCalls`.
Counts are **AG-visible calls** (`execute()` invocations) — driver-internal I/O is the
driver's business, same doctrine as Redis's internal reads today.

### 1b. TestSuite "Driver-call budgets" section

A new describe using a **dedicated, hook-free model** (a fresh model name no other section
registers listeners against). Budgets at Part-1 landing assert today's reality; Part 2's
contract change updates the update/delete rows (one deliberate edit, part of that contract
change):

| Operation | Part 1 budget | After Part 2 |
|---|---|---|
| `createOne` | 1 | 1 |
| `findOne` by id, twice in one request | 1 (DataLoader raw-row cache) | 1 |
| `findMany` + N populated links | 2 (batch `$in` merge — pins the DataLoader guarantee) | 2 |
| `updateOne` (no hooks, no embedded, no custom update-stage pipelines) | 2 | **1** |
| `deleteOne` (no RI edges) | 2 | **1** |
| `createMany` of N | N | N (the budget the 0.16 batch-op goal must beat) |

### 1c. Benchmark scripts (`workspace/autograph/bench/`)

Not CI-gated; `npm run bench`. Two synthetic drivers isolate the two taxes:

- **`InstantDriver`** — in-memory, immediate resolution. Isolates framework CPU: rows/sec
  through the full read path (docTransform, selection eager/lazy, DocClass) for narrow
  (5-field) and wide (30-field, embedded, deserialize-heavy) models; full mutation
  lifecycles/sec (validate → transform → dispatch → events).
- **`LatencyDriver`** — wraps InstantDriver with a configurable per-call delay (default
  1ms). Makes round-trip counts visible as wall-clock — Part 2's win shows up here.

Baselines recorded in `bench/RESULTS.md` (date, node version, numbers) before Parts 2–3;
each part appends its after-numbers. The bench is the arbiter: any Part-3 sub-item whose
delta doesn't pay for its complexity gets dropped, not kept on vibes.

---

## Part 2 — Pre-image elision on a strengthened driver contract

### Contract change (base contract, not a capability)

The driver contract gains a mutation-result obligation, enforced by the TestSuite for every
driver:

> **`updateOne` resolves to the post-image row; `deleteOne` resolves to the pre-image row**
> (raw DB shape, exactly as a find would return it — deserialize applies above, as always).
> Natively if your substrate supports it (`RETURNING`, `findOneAndUpdate`); by internal
> refetch if it doesn't.

Rationale: the doc must materialize somewhere (it IS the mutation's response), and the
driver is the only layer that knows whether returning it is free. No `supports` flag — this
is a storage-semantics obligation like the `/duplicate/i` duplicate-key error format, not a
substrate personality trait. Breaking for third-party drivers; 0.16 is unpublished.

Compliance work (audited during grounding):

- **MongoDriver** — update: already conformant (`findOneAndUpdate` +
  `returnDocument: 'after'`). Delete: `deleteOne` → `findOneAndDelete`.
- **PostgresDriver** — update: already conformant (`UPDATE … RETURNING *`; the
  partial-JSONB branch read-merge-writes internally — still one AG-visible call). Delete:
  `.delete()` → `.delete().returning('*')` (+ PgMemShim support for DELETE…RETURNING).
- **RedisDriver** — both paths already resolve the doc internally (index maintenance);
  return what's already held.

### What the pre-fetch actually serves (audit)

With the response already coming from the driver result, `QueryResolver`'s `#get` pre-fetch
feeds exactly five consumers — each statically knowable, request-time knowable, or
preservable through the returning write:

1. **Doc-dependent pipelines** — `immutable`, `selfless` read `query.doc`; custom pipelines
   *might*; `$pk` reads it only for embedded-array-element id preservation (top-level,
   `doc.id === query.id` — same value either way).
2. **`toDriver()`'s embedded null-parent merge** — `collectNullParents` walks `doc`.
3. **Event hooks** — `query.doc` / `query.merged` on every mutation-lifecycle event.
4. **The 404 contract** — `#get(..).one({ required: true })`.
5. **Delete** — the RI walk reads FK values off the pre-image; the delete result is the
   pre-image (now supplied by the contract when no RI walk runs).

### Doc-freedom: internal audit, no public metadata (deferred)

No user-facing `docDependent` option in v1. Instead:

- Presets are tagged internally at `createPresets()` time: `immutable` and `selfless` are
  the framework's known doc-readers (`$pk` deliberately not tagged — its doc-use is
  exclusive to embedded-array elements, and embedded models are categorically excluded
  below, so the tag never lies where it's consulted).
- Any **custom** (non-preset) pipeline appearing in an update-stage chain makes the model
  not doc-free — the framework cannot prove a user function doesn't read `query.doc`.

A public `Pipeline.define(name, fn, { docDependent: false })` opt-out is a purely additive
follow-up for schemas that want elision on custom-pipeline models — deliberately out of v1.

### Parse-time flags (computed in `buildDerived`)

- `$model.updateDocFree` — no doc-reading pipeline (per the audit above) in any update
  stage (`validate`, `restruct`, `instruct`, `normalize`, `serialize`) on any field, AND no
  embedded fields (one stroke excludes both the `toDriver` null-parent merge and `$pk`'s
  element semantics — v1 conservative; embedded refinement is a later, separate decision).
- `$model.deleteDocFree` — `referentialIntegrity.length === 0`.

### The `$model.preImage(query, resolver)` slot

Installed by `buildDerived`, replacing the raw `#get` call sites for `updateOne`/`deleteOne`
(`terminate` always awaits the slot — no branching at the call site):

- **Not doc-free** → today's fetch exactly: `resolver.match(model).id(id).one({ required: true })`.
- **Doc-free** → the runtime-only check lives inside: sweep `hasListenersFor` across the 7
  mutation-lifecycle events (`preMutation`, `validate`, `postMutation`, `preResponse`,
  `postResponse`, `postCommit`, `postRollback` — shared as one constant with
  `#createSystemEvent`'s bypass so the lists cannot drift). Any listener → fall back to the
  real fetch (listeners are entitled to `query.doc`/`query.merged`). None → resolve
  `undefined` (elided).

**404 preservation:** an elided update/delete rides the existing `flags.required` mechanism —
`Resolver.resolve` already throws `Boom.notFound(\`${model} Not Found\`)` on a null required
result. Same error class and message; only the timing (post-dispatch vs pre-dispatch)
differs, and by construction nothing observes the interior of that window. Elided writes are
otherwise unchanged — still sessioned under an ambient scope, still serialized through
`TransactionScope.run`, still subject to settled-scope stale-write rejection.

`pushOne`/`pullOne`/`spliceOne` are inherently doc-computed (the new array derives from the
current one) — never elided. `updateMany`/`deleteMany` keep their enumerating `#find`; each
per-id inner op is independently elision-eligible. The RI walk's in-transaction pre-fetch is
untouched.

### Tests

- Budget flips (Part 1's table) — the round-trip proof.
- Guard correctness: a model WITH an `immutable` field still gets `query.doc` populated; a
  listener registered on an otherwise-elidable model restores the pre-fetch; unregistering
  (disposer) re-enables elision.
- Contract conformance: new TestSuite assertions that `updateOne`/`deleteOne` driver results
  ARE the post-/pre-image (runs for every driver — this is what makes the contract real).
- Every existing semantic section passes unchanged — the zero-semantic-change proof.

---

## Part 3 — Compiled transformers (closure backend behind the existing slots)

### Where interpretation is still paid (audit)

Per doc, per field with an n-step chain, today's cost through three layers:
`Transformer#applyKey` allocates `{ startValue, value, ...callArgs }` per step; the
`Pipeline.define` wrapper allocates `{ ...args, value }` again per item (itemize); structure
pipelines (`$normalize` et al.) allocate `{ ...params, value }` per sub-transformer in
`Pipeline.resolve`. A 3-stage field on a create pays ~6–9 wide-bag spreads. On the read
path, `docTransform` re-derives per-field flags (`pipelines.deserialize.length`,
`isEmbedded`, `isArray`) for every field of every row on every call — and transformation
runs per call by design.

### 3a. Compiled `Transformer` (the fold-in)

`Transformer.config()` becomes the compile step: from `shape` it precomputes the entry list
and per-field chain plans (rename target, itemize/ignoreNull behavior folded in,
Promise-to-`$thunks` handling, purity — below). `transform()` executes the plan: a
specialized loop over precomputed entries plus the passthrough sweep for unknown keys.
Public surface unchanged (`config`, `args`, `clone`, `transform`) — `$model.transformers.*`
callers never know. Semantics byte-identical (rename ordering, `Util.uvl`
undefined-keeps-previous, `keepUndefined`, `strictSchema`, validate's defaults seeding),
asserted by the existing Transformer/pipeline test surface.

**Params reuse (purity):** presets are audited and tagged internally as non-retentive (they
destructure in the signature; the audit includes `ensureFK`, whose async work closes over
destructured locals, not the bag). A field whose entire chain is non-retentive presets gets
ONE params object allocated per field, `.value`/`.startValue` mutated between steps —
including through a reuse-aware `Pipeline.resolve` path. Any custom pipeline in the chain →
that field falls back to per-step allocation (the framework can't prove a user function
doesn't retain the bag). Same deferral as Part 2: a public `{ retentive: false }` opt-out is
an additive follow-up, not v1.

### 3b. `docTransform` field partitions

In `buildDerived` (and the interface-model rebuild, which must recompute them), partition
`$model.fields` once: `simple` (key === name, not array, not eligible — direct copy),
`renamed`, `arrays`, `eligible` (embedded/deserialize). The per-row loop iterates
partitions with flags baked in; a model with an empty `eligible` partition skips
selection/laziness logic entirely (identity-plus-rename fast path — the common case for
skinny models). Behavior identical: same lazy-getter installation, same shallow array
copies, same `$transformed` idempotence.

Measured by Part 1's `InstantDriver` bench before/after; each sub-item lives or dies by its
recorded delta.

---

## Ordering & deliverables

1. **Part 1** — instrumentClient, budgets section wired into all four driver packages,
   `bench/` + RESULTS.md baselines.
2. **Part 2** — driver contract change (Mongo/PG delete returning; TestSuite conformance
   assertions), internal doc-reader audit, parse-time flags, `$model.preImage` slot, budget
   flips, guard tests, CLAUDE.md driver-contract + pre-image docs.
3. **Part 3** — compiled Transformer + purity audit, docTransform partitions, bench deltas
   appended to RESULTS.md.

## Explicitly out of scope (deferred)

- Public `docDependent` / `retentive` pipeline options (additive follow-ups once v1 proves
  the machinery).
- `new Function` codegen backend (drop-in behind the same slots, only if bench data demands).
- On-disk/build-step codegen (rejected outright — breaks runtime composition and the
  boot-time validation story).
- Cross-request entity caching (semantic change; userland/emitter territory).
- Per-call selection-driven projection and a future `@field(lazy:)` annotation (separate
  spec if bench data demands).
- Memoizing deserialized rows in the DataLoader (fresh-instances guarantee is load-bearing).
- Where-clause shape memoization (revisit if bench shows where-transform hot).
- Embedded-model refinement of `updateDocFree`.
- True driver-level `*Many` batching — standing 0.16 goal, tracked there.

## Risks

- **Custom pipelines suppress the wins silently** — custom update-stage pipelines block
  elision; custom chain steps block params reuse. Acceptable: correctness first, and the
  deferred public opt-outs are the escape valve. The bench RESULTS.md should note this so a
  "why no gain on my schema" investigation starts in the right place.
- **Guard drift** — a future event or doc consumer added without updating the elision guard.
  Mitigated by the shared event-list constant and the Part-2 guard tests.
- **Params-object mutation (3a)** is the sharpest edge — a mis-audited preset retaining the
  bag would see later fields' values. The audit is one file, the fallback is per-field, and
  custom code is categorically excluded from reuse.
- **Contract change ripples to any out-of-tree driver** — deliberate; the TestSuite
  conformance assertions turn a silent semantic obligation into a loud red test.
