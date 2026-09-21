# Test split — clusters, census, and `test:fast`

Companion to `test.census.tsv` (raw data), `test-census.sh` (regenerates it),
and `test.order.ts` (consumes it). Written 2026-09-21 on `v4/test-split`,
based on `origin/main` at `63e1db0`.

## The problem

The full suite is 1022 tests across 66 files in 712.87s (measured, single
combined `bun run test:full` run). A one-line change to a pure codec waited
behind ~400s of gate-serialized, multi-process, real-SIGKILL recovery tests
before it knew whether it broke anything.

## I changed one file, what do I run?

In this order:

1. **`bun run test:<kernel>`** — the file you touched, e.g. `bun run
   test:context` after a context change. This is the loop for while you
   work. Most kernels genuinely are seconds (`test:auth` is 1.06s for 157
   tests); a handful are not — see "per-kernel reality" below before
   assuming every kernel is fast.
2. **`bun run test`** — the full suite, census-ordered fast-first, `--bail`.
   Run before you consider the change done. With ordering now driven by
   measured time instead of a filename guess, a regression in a cheap file
   surfaces in about a second — `--bail` stops at the first failure and the
   cheap files genuinely run first now.
3. **`bun run test:fast`** — pre-push gate. Skips the slowest 10-file tier.
   Still ~475s (see below) — not a during-work loop, a cheaper full-ish gate.
4. **`bun run test:full`** — before merge. Every file, no bail, the number
   everything else here is measured against.

## Per-kernel scripts

Derived from the actual filenames in `test/` (61 flat files, plus 4 more
nested under `test/fixtures/{context,publication}-v1/*.test.ts` that a
non-recursive scan had been silently skipping — see below), not assumed from
a list. 24 clusters, one `test:<kernel>` script each, covering all 66 files
(65 under `test/` + `../cli.test.ts`) exactly once — verified
programmatically, no gaps, no file in two scripts:

| Cluster | Files | Script |
|---|---|---|
| association | 4 | `test:association` |
| auth | 4 | `test:auth` |
| batch-worker | 1 | `test:batch-worker` |
| chat | 4 | `test:chat` |
| cli | 1 (`../cli.test.ts`) | `test:cli` |
| context | 3 + 1 nested (`fixtures/context-v1/precision.test.ts`) | `test:context` |
| contract | 2 | `test:contract` |
| evidence | 1 | `test:evidence` |
| jcs | 1 | `test:jcs` |
| knowledge-chat | 2 | `test:knowledge-chat` |
| lifecycle | 4 | `test:lifecycle` |
| mcp | 1 | `test:mcp` |
| publication | 3 + 3 nested (`fixtures/publication-v1/*.test.ts`) | `test:publication` |
| read-cursor | 4 | `test:read-cursor` |
| replay | 1 | `test:replay` |
| revision | 2 | `test:revision` |
| search-chunk | 4 | `test:search-chunk` |
| session-link | 4 | `test:session-link` |
| source-ingestion | 1 | `test:source-ingestion` |
| target-schema | 1 | `test:target-schema` |
| taxonomy | 3 | `test:taxonomy` |
| trace | 4 | `test:trace` |
| transport | 4 | `test:transport` |
| ui-scope | 1 | `test:ui-scope` |
| workspace-isolation | 2 | `test:workspace-isolation` |

No file resisted classification — every file's prefix maps cleanly to one
kernel, including the four single-file kernels (`batch-worker`, `evidence`,
`mcp`, and the standalone `cli.test.ts`) and the two-tier
`ownership`/`precision`/`recovery`/`service` naming most kernels share.

### Per-kernel reality: seconds for most, minutes for a few

"Per-kernel target instead of the full suite" is not uniformly a
seconds-scale win — say so plainly rather than let the headline imply it.
Summed per-file census time for every `test:<kernel>` script (same
upper-bound-not-real-run-time caveat as everywhere else in this doc), sorted
slowest first:

| Script | Files | Tests | Summed time |
|---|---|---|---|
| `test:publication` | 6 | 96 | 195.99s |
| `test:taxonomy` | 3 | 91 | 153.18s |
| `test:read-cursor` | 4 | 83 | 141.66s |
| `test:association` | 4 | 80 | 123.47s |
| `test:context` | 4 | 81 | 90.55s |
| `test:trace` | 4 | 35 | 89.06s |
| `test:session-link` | 4 | 33 | 74.16s |
| `test:workspace-isolation` | 2 | 22 | 56.91s |
| `test:lifecycle` | 4 | 23 | 51.22s |
| `test:search-chunk` | 4 | 42 | 46.20s |
| `test:chat` | 4 | 41 | 23.84s |
| `test:transport` | 4 | 40 | 7.17s |
| `test:target-schema` | 1 | 4 | 4.33s |
| `test:revision` | 2 | 12 | 2.74s |
| `test:cli` | 1 | 49 | 1.90s |
| `test:contract` | 2 | 9 | 1.76s |
| `test:batch-worker` | 1 | 12 | 1.58s |
| `test:auth` | 4 | 157 | 1.06s |
| `test:mcp` | 1 | 24 | 0.97s |
| `test:knowledge-chat` | 2 | 8 | 0.69s |
| `test:ui-scope` | 1 | 13 | 0.09s |
| `test:jcs` | 1 | 11 | 0.08s |
| `test:source-ingestion` | 1 | 39 | 0.08s |
| `test:evidence` | 1 | 11 | 0.04s |
| `test:replay` | 1 | 6 | 0.03s |

14 of 24 kernels are under 10s. The other 10 — every kernel whose files span
`ownership`/`precision`/`recovery`/`service` (or the nested `fixtures/*-v1/`
equivalent) — run 46s to 196s, because that's where the real fd-42 writer
gate and real-SIGKILL recovery tests live. `test:publication`,
`test:taxonomy`, `test:read-cursor`, and `test:association` (the four asked
about explicitly) are all in that slow group: 196s, 153s, 142s, and 123s
respectively, not seconds. A change to one of those four kernels gets the
same feedback-loop problem the whole suite has, just smaller — real, but not
solved by splitting alone.

## The `test.order.ts` own-goal, found while building this

`test.order.ts` scanned `test/` with a non-recursive `readdirSync`. Four real
test files live nested one level deeper, under
`test/fixtures/{context,publication}-v1/`, and were silently dropped from
`bun run test` (which reads `test.order.ts`'s output) while `bun run
test:full` (which hands the whole `test` directory to `bun test`, recursing
by default) still ran them:

- `test/fixtures/context-v1/precision.test.ts` — 12 tests
- `test/fixtures/publication-v1/references.test.ts` — 7 tests
- `test/fixtures/publication-v1/limits-integrity.test.ts` — 4 tests
- `test/fixtures/publication-v1/precision.test.ts` — 1 test

A green `bun run test` meant nothing for these — they never ran. Fixed:
`test.order.ts` now scans recursively, with an independent manual-walk
cross-check that throws if the two scan methods ever disagree (see the file
for the full comment). `test.order.txt` went from 61 to 65 lines. Folded into
`test:context` / `test:publication` above so per-kernel coverage stayed
exact.

## Timing census — measured, not guessed

`test-census.sh` runs every one of the 66 files as its own bare `bun test`
invocation and records wall-clock seconds. **Caveat, load-bearing**: each
invocation pays its own process startup + module load + fixture setup that a
single combined run amortises across all files. So these numbers are an
upper bound on each file's share of a real run, and their sum is expected to
be — and is — MORE than one combined run's wall clock:

- Summed per-file census: **1068.74s**
- Single combined `bun run test:full` baseline: **712.87s**
- Ratio: **1.50x**

That ratio is the evidence the census script now checks automatically
(`test-census.sh` refuses to write `test.census.tsv` if the summed time is
under half the baseline — the signature of every file failing fast on a
missing dependency, which is exactly what happened on the first attempt in
this session: a worktree with neither `app/server/node_modules` nor
`app/migrate-py/.venv` installed produced a "complete" 66-row census summing
to ~3 seconds. Both are now preflight-checked and refused-to-run-without, not
just fixed once).

### Top 15 slowest (standalone)

| File | Standalone time | Tests |
|---|---|---|
| `test/publication-recovery.test.ts` | 65.33s | 26 |
| `test/taxonomy-service.test.ts` | 59.16s | 61 |
| `test/read-cursor-precision.test.ts` | 56.19s | 21 |
| `test/association-recovery.test.ts` | 53.48s | 17 |
| `test/taxonomy-recovery.test.ts` | 51.23s | 17 |
| `test/fixtures/publication-v1/references.test.ts` | 44.72s | 7 |
| `test/read-cursor-recovery.test.ts` | 43.99s | 17 |
| `test/workspace-isolation.test.ts` | 42.94s | 19 |
| `test/taxonomy-ownership.test.ts` | 42.79s | 13 |
| `test/trace-precision.test.ts` | 40.30s | 11 |
| `test/publication-service.test.ts` | 31.76s | 29 |
| `test/context-service.test.ts` | 30.32s | 49 |
| `test/association-query.test.ts` | 29.66s | 20 |
| `test/association-service.test.ts` | 29.60s | 36 |
| `test/session-link-recovery.test.ts` | 28.95s | 11 |

Every file in the census reported `0` failures — the suite is green
file-by-file as well as in aggregate (pass total 1022, fail total 0).

### Every file ran standalone — no inherited-gate isolation failures

All 66 files, including every `ownership`/`recovery` file that spawns a real
child process and holds/contends the fd-42 writer gate, ran clean alone with
no dependency on state left behind by another file. That means a per-file
(or per-kernel) `test:` target is viable for every file — nothing in this
suite requires the shared setup a combined `bun test <many files>` run
provides. This is a real finding, not an absence of evidence: the census
ran each file as a cold, isolated `bun test <file>` process and 1022/1022
tests passed.

### The `isSlow` regex vs measured reality

`test.order.ts` previously ordered files with a name heuristic:
`isSlow = /recovery|ownership/`. The census shows that heuristic is close to
noise. Examples of files it puts in the "fast" bucket that are actually among
the slowest 10, and files it defers as "slow" that are actually near-instant:

| File | `isSlow` says | Measured | Actually |
|---|---|---|---|
| `taxonomy-service.test.ts` | fast | 59.16s | slowest tier |
| `read-cursor-precision.test.ts` | fast | 56.19s | slowest tier |
| `fixtures/publication-v1/references.test.ts` | fast | 44.72s | slowest tier |
| `workspace-isolation.test.ts` | fast | 42.94s | slowest tier |
| `trace-precision.test.ts` | fast | 40.30s | slowest tier |
| `transport-ownership.test.ts` | slow | 0.32s | near-instant |
| `transport-recovery.test.ts` | slow | 6.34s | fast |

`test.order.ts` now sorts by the measured time in `test.census.tsv`
directly, falling back to this same regex — slow-biased — only for a file
that has no census entry yet (new since the last regeneration). See the
"missing entries are not silent" note in `test.order.ts` and
`test.census.tsv`'s header.

## `test:fast`

Files below `SLOW_CENSUS_CUTOFF_SECONDS = 35` (see `test.order.ts` for how
that constant was chosen from the measured gap between 31.76s and 40.30s —
the largest gap in the top 20, ~8.5s versus 1-3s neighbours). Regenerated
into `test.fast.txt` by `bun run test:order`, consumed by `bun run
test:fast`.

- **56 of 66 files** (55 from `test/` + `../cli.test.ts`), **813 of 1022
  tests (79.6%)**.
- Excludes exactly the 10-file slow tier in the table above (209 tests,
  20.4%).
- **Real measured wall-clock time** (one combined run, same measurement
  method as the 712.87s baseline — not summed standalone numbers):

  | | Files | Tests | Time |
  |---|---|---|---|
  | `test:fast` | 56 | 813 (100% pass) | **474.90s** |
  | `test:full` | 66 | 1022 (100% pass) | 712.87s |

  79.5% of the tests in 66.6% of the wall clock. **Be plain about what this
  means: `test:fast` is not fast.** Just under 8 minutes is not a
  during-work loop — nobody runs an 8-minute command between edits. It is a
  reasonable pre-push gate (skip the slowest tier, keep most of the
  coverage) and nothing more. The actual answer to "fail fast" is the
  per-kernel targets above and `--bail` over census-ordered files in
  `bun run test`, not this script.

`test` and `test:full` are unchanged in behaviour: `test` still runs the
full measured order with `--bail`, `test:full` still runs everything via a
directory arg. Existing callers of either see no difference except that
`test` now genuinely covers all 66 files instead of 62 (see the own-goal
section above).
