# Benchmark results

Run `npm run bench` (workspace/autograph). Append a dated section per milestone — the deltas
here are the initiative's success criterion. Custom-pipeline-heavy schemas won't see Part 2/3
gains (conservative defaults block elision and params reuse) — start any "why no gain"
investigation there.

## Baseline (pre-Part-2) — 2026-07-05

```
node v22.23.1 — 2026-07-05T15:44:40.265Z

read: findMany 500 narrow rows (fresh resolver)                  2887 ops/sec
read: findMany 500 wide rows (fresh resolver)                     830 ops/sec
mutation lifecycle: createOne narrow                            18079 ops/sec
mutation lifecycle: updateOne narrow (incl. pre-image)           4501 ops/sec
latency(1ms): updateOne narrow end-to-end                         212 ops/sec
```

## After Part 2 — 2026-07-05

Node version matches the baseline exactly (v22.23.1) — no version caveat needed.

```
node v22.23.1 — 2026-07-05T16:13:59.060Z

read: findMany 500 narrow rows (fresh resolver)                  2767 ops/sec
read: findMany 500 wide rows (fresh resolver)                     818 ops/sec
mutation lifecycle: createOne narrow                            17422 ops/sec
mutation lifecycle: updateOne narrow (incl. pre-image)           5283 ops/sec
latency(1ms): updateOne narrow end-to-end                         386 ops/sec
```

`latency(1ms): updateOne narrow end-to-end` goes from 212 to 386 ops/sec (+82%), consistent
with pre-image elision dropping the update's driver-call budget from 2 to 1 — one fewer
1ms round trip per mutation on this doc-free/hook-free path. Read paths and createOne are
within normal run-to-run noise (unaffected by this change, as expected).

## After Part 3 — 2026-07-05

Node version matches the baseline exactly (v22.23.1) — no version caveat needed. Part 3
(params-object reuse across `argsSafe` preset chains; `docTransform` field partitions + the
`eligibleCount === 0` identity fast path) targets the CPU scenarios specifically — three
consecutive `npm run bench` runs were taken (not just one) to separate signal from this
harness's normal run-to-run noise, since the single-sample deltas in this section alone span
a wider range than some of the effects being measured.

```
node v22.23.1 — 2026-07-05T16:40:16.239Z

read: findMany 500 narrow rows (fresh resolver)                  2978 ops/sec
read: findMany 500 wide rows (fresh resolver)                     818 ops/sec
mutation lifecycle: createOne narrow                            17936 ops/sec
mutation lifecycle: updateOne narrow (incl. pre-image)           4969 ops/sec
latency(1ms): updateOne narrow end-to-end                         371 ops/sec
```

Two more back-to-back runs for noise context: read narrow {2865, 2831}; read wide {794, 774};
createOne {15792, 16165}; updateOne-incl-pre-image {4826, 5156}; latency {381, 384}.

Per-scenario, against BASELINE (not Part 2):

- `read: findMany 500 narrow rows` — baseline 2887, Part 3 avg ~2891 (2978/2865/2831). **No
  measurable delta.** The `Narrow` model has zero embedded/deserialize-eligible fields, so it
  already qualifies for the new identity fast path on every row — but the per-field branching
  this replaces was apparently cheap relative to the rest of the read path (query build,
  DataLoader, selection), so removing it doesn't move throughput outside noise.
- `read: findMany 500 wide rows` — baseline 830, Part 3 avg ~795 (818/794/774). **No measurable
  delta** (if anything a slight dip, but smaller than the -1.4% already seen baseline→Part2, so
  not attributable to Part 3). `Wide` has exactly one eligible field (`meta`, embedded), so the
  model as a whole does NOT qualify for the identity fast path — it still runs the per-field
  lazy-getter/selection machinery for every row; only the redundant per-row re-derivation of
  `hasEmbedded`/`hasDeserialize` was removed, which is not where this scenario's CPU goes.
- `mutation lifecycle: createOne narrow` — baseline 18079, Part 3 avg ~16631 (17936/15792/16165,
  a ~12% spread across just these three runs). **No measurable gain, and honestly this trends
  slightly below baseline** — but the spread within Part 3's own three samples is wider than the
  apparent regression, so this reads as noise-dominated rather than a real slowdown. `createOne`'s
  pipelines are mostly single-step (default-value generator, one or two presets), leaving little
  chain length for `argsSafe` bag reuse to amortize away. **Candidate for follow-up profiling**
  if createOne throughput matters at larger scale — not reverting anything here, just flagging it.
- `mutation lifecycle: updateOne narrow (incl. pre-image)` — baseline 4501, Part 2 5283, Part 3
  avg ~4984 (4969/4826/5156). Sits between baseline and Part 2, inside the noise band either
  side straddles. Holds Part 2's structural win (elision) but **no additional delta cleanly
  attributable to Part 3's params-reuse specifically** at this bench's scale/sample size.
- `latency(1ms): updateOne narrow end-to-end` — baseline 212, Part 2 386, Part 3 avg ~379
  (371/381/384, i.e. +75-81% over baseline). **Holds the Part-2 gain**, as expected — this
  scenario is dominated by round-trip count (still 1 driver call per update), which Part 3
  doesn't change, not by in-process CPU.

Honest summary: Part 3's CPU-targeted changes (params-object reuse, docTransform partitioning)
show no measurable throughput delta on this synthetic bench's read and createOne scenarios —
the allocations/branches removed are real (see the diff) but small relative to everything else
on these paths, and full JS ops/sec noise on this machine can span several percent run-to-run.
Nothing here is being reverted (per the owner's-call rule) — flagging createOne's below-baseline
trend and the read scenarios' flat trend as candidates the owner may want to profile more
precisely (e.g. with `--prof`/allocation sampling instead of wall-clock ops/sec) rather than via
this harness alone. `updateOne`/`latency` continue to reflect Part 2's real, load-bearing win.
