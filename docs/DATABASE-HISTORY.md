# The database, as it was decided

Dug 2026-09-21 from all 12 discussions and the decision issues, read in full.
Every quote below is verbatim from the source named beside it. Where the record
is silent, this file says so rather than filling the gap.

Companion to `SCHEMA-BUILT.md`, which records what the schema IS. This one
records how it got there, and — more usefully — **which decisions were made
somewhere other than where you would look for them.**

---

## The short version

The `memories` table was replaced by `nodes` + `node_revisions`. That change was
proposed in a discussion, restated in another, and **formally frozen in an
issue** — not in any discussion, and not in `SPEC.md`, which still describes
`memories` today. Anyone reading the discussions alone concludes it was never
decided. Anyone reading `SPEC.md` alone concludes it never happened. Both are
wrong, and both are reasonable readings of what they read.

---

## 1 · The foundation day — 2026-09-18, discussions #12-#17

Six discussions in one day, and the method is visible in the order: design
argument, translation, full visual audit, compression, first code, direct
measurement.

| # | time | what it did |
|---|---|---|
| #12 | 02:51 | three tiers settled; four questions left open |
| #13 | 03:16 | Thai explainer — and found a new defect while drawing |
| #14 | 03:19 | every table on one page, from `SPEC.md v26.9.18-alpha.915` |
| #15 | 03:26 | one-screen cheatsheet, nothing new |
| #16 | 03:55 | first code: compiled Rust + LanceDB migration |
| #17 | 05:13 | measured the platform boundary |

**Settled that day and not relitigated since:**

- Tier 1 is Honcho's five tables, byte-compatible, nullable additions only.
- Exactly one surface alias: `bank` = `workspaces`. No `banks` table, no
  `bank_id` column.
- Sessions are flat. No `parent_id`, no channel/thread split.
- Column vs JSON decided by one rule: *"is it a filter key or a display
  field?"* — because "libSQL and Lance both push predicates down on columns and
  neither does on JSON."
- Composite FK `(x_name, workspace_name)` named the one property "not to trade
  away for anything," making a cross-bank reference "a constraint violation at
  INSERT, not a failed assert." (#12)

**Two things worth knowing about how those decisions were found.**

#13, the Thai post, caught a flaw in its own proposal *while drawing the ASCII*
and said so: "ข้อโต้แย้งของ B โผล่ตอนวาด ASCII นี่แหละ ไม่ได้เห็นตอนคิดในหัว" —
the objection to option B appeared while drawing this ASCII, not while thinking
it through. The flaw: replacing `is_active` with `tier` would put a human
unpublish and an automated sweep on the same column — "two writers one fact,"
which §14.4 forbids.

#14 found three defects that prose had hidden: two auth tables (`tokens`,
`oauth_clients`) referenced but never given a schema, one deliberately
unenforced foreign key documented nowhere, and one "controlled" vocabulary
(`trace_hits.kind`) whose closed set was never listed.

**Measured that day, not estimated:**

- Thai FTS: `ความ` returns **435 hits on trigram, 5 on unicode61**, on this
  corpus. v3 shipped `porter unicode61` and is "structurally unable to find Thai
  inside words." (#14)
- LanceDB's TypeScript client is a **221 MiB** native binary against
  Cloudflare's **64 MiB** Worker ceiling — **3.45x over, on one platform**,
  before any of our code. That killed the Workers-only shape by measurement
  rather than preference. (#17)
- `SPEC.md` §4.7's commit-lock warning was found **stale in our favour**: three
  upstream Lance issues closed in 2025 made conditional put the default commit
  strategy. "We were wrong in our favour." (#17)

---

## 2 · The drift — #18 to #21

**#18 (Sep 18)** is a verification pass: it opened all 15 `.lance` tables, read
their Arrow schemas, and diffed them against `SPEC.md v26.9.18-alpha.915`. It
found one real defect — `memories` had silently lost `last_sync_at` and
`sync_attempts` — and one table nobody specced, `read_cursors`, which "appears
ZERO times in 2,195 lines of SPEC.md."

The post then **corrected itself the same day**. It had blamed #14 for
mentioning the sync columns only in prose; #14 had in fact boxed all three
correctly. The corrected finding is sharper than the original: "Both written
sources were correct. The code lost the columns anyway." A transcription defect,
not a spec ambiguity. Fixed by `f41018d`.

**#19 (Sep 19)** is Nat's own question, quoted verbatim into the record:
*"i think superseded should flat we should can direct insert of like wrong
undertanding stuff? and memory have like short term / long term? how ? add tags?
vocab /tearm?"* The answer proposed: corrections are directly insertable rows,
and horizon is a controlled vocabulary term — **not a new column**.

**#20 (Sep 19)** reframed everything as "conversation → knowledge entity" on the
back of ten Relic evidence passes, and proposed replacing `memories` with a
Drupal-like `entities` + `entity_revisions` apparatus plus ~15 supporting tables.

**#21 (Sep 20)** walked that back — "This document simplifies #20; it does not
erase it" — collapsing the proposal to `nodes` + `node_revisions` +
`node_revision_terms` + `revision_links` + `search_chunks_v1`, and landing on 19
tables with a field-by-field migration map.

**None of these four accepted anything.** Every one self-labels: #19 "Status:
discussion proposal, NOT an approved migration or implemented feature"; #20
"design discussion, not an implemented migration or an approved replacement
SPEC"; #21 "consolidated design for discussion, not a completed migration."

---

## 3 · Where it was actually decided — issue #23

This is the part that is easy to miss, because it is not in a discussion.

**Issue #23 froze the contract on 2026-09-20**, and states the arithmetic that
every later document repeats:

> "Baseline15 and proposed target19 remain distinct. **The target is 15 - 2 + 6,
> not 15 + 4.**"

Accepted with named commits and digests:

| commit | what |
|---|---|
| `8618094` | isolated Python target19 registry, 228 fields, drift checks |
| `6289311` | revision/evidence canonical bytes — contract SHA `a854cf85…` |
| `33e3c44` | source-ingestion / legacy boundary validators |
| `b232a5a` | `target-19-manifest.json` |

An independent review had returned **"Verdict: REVISE — direction is sound,
contract not frozen or implementation-ready"** before the gaps were closed and
the final acceptance recorded.

**What #23 did NOT do, in its own words:** "#23 defines and tests the versioned
contract, not the full product… Runtime remains the active15/eight-tool
unauthenticated spike." The manifest records the target as
**`proposed-not-active`**.

### The live gap

`storage.ts` now **enforces** the 19-table shape — it refuses to open a dataset
that is not exactly it. The manifest that #23 froze still says
`proposed-not-active`, the active Python registry `arra_migrate.models.TABLES`
is still the 15-table baseline, and `app/data/` on disk is still the 15-table
shape with `memories.lance` in it.

So the honest statement is not "nobody decided." It is: **the runtime moved past
the status its own frozen manifest still records.** The decision exists; the
manifest and the active registry were never moved to match it.

---

## 4 · Decisions made once and still load-bearing

| when | decision | where recorded |
|---|---|---|
| 2026-09-18 | **Forgetting = binary `is_active`.** No tier, no decay columns, no access tracking. | issue #2, closed |
| 2026-09-20 | Contract frozen at target19; 15 − 2 + 6 | issue #23, closed |
| 2026-09-20 | SessionSource: **neither** session-viewer nor lanceglass — a read-only Relic adapter | issue #3, closed |
| 2026-09-20 | Django admin rejected; browsing folded into #33 | issue #11, closed |

The forgetting decision is worth reading in full, because it was argued from
evidence rather than taste. Tier-based demotion was rejected because v3's own
sweep was wired to a stats read: "A memory nobody looks at is never re-scored,
so it never demotes." A decay score was rejected as "the S5 failure mode by
name" — v3 UPDATEs every returned row on every recall, so "the decay is
access-driven, and access is exactly what decay exists to punish."

It also names its own overturn condition, which was never run:
`SELECT tier, count(*) FROM oracle_memories GROUP BY tier` against a live v3
database. No live v3 database was found. The decision stands on the argument,
not on that measurement.

---

## 5 · Decisions made without the measurement that was supposed to decide them

**Spike S9 (issue #6)** was designed to settle libSQL-vs-LanceDB by measurement:
10k real docs, F32_BLOB, trigram, a 50 ms threshold. It was **closed without
being run** — "The storage choice moved to **LanceDB** before the spike ran."

The issue is explicit that this is historical rather than resolved. The storage
backend was chosen without the comparison that was commissioned to choose it.

**The tokenizer is the same shape of gap, and still open.** `SPEC.md` §4.1.2
commits to `tokenize='trigram'`, *"non-negotiable… Never unicode61"*, with the
435-vs-5 measurement behind it. The running code at `app/server/src/db.ts:112`
uses `Index.fts({ baseTokenizer: "icu" })` — neither. A measured counterexample
already exists: stored `หลงลืม`, queried `ลืม`, ICU returns **no hits** where
native ngram3 returns that row at rank 1.

Resolution is blocked on **issue #7**, which #22 calls "the hidden critical
path."

---

## 6 · Named gaps, still open

| # | gap |
|---|---|
| #85 | `getContext` reported `coverage:"full"` while omitting unauthorized evidence; `excluded` unbounded against a 64 KiB cap |
| #87 | membership is a read boundary only inside `getContext`; `listMessages` never checks it |
| #88 | **no listing endpoint anywhere** — `getAcceptedHead` is wired and registered but unreachable, because nothing returns a bare `node_id` |
| #89 | **no conclusion-shaped table** in the 19 — #36 says a conclusion is a node of type `conclusion`; the schema has not implemented that |
| #7 | the retrieval measurement everything above is waiting on |

#88 and #89 are the two that bound what any UI can show. #88 is why a browser
cannot open on a list of peers or nodes, and why a node/revision view cannot be
built at all yet. #89 is why the Honcho-shaped "conclusions" surface has nothing
to render.

---

## 7 · The pattern worth keeping

Three times in this record, drawing or building something found a defect that
reading had not:

- #13 found the two-writers-one-fact flaw **while drawing the ASCII**.
- #14 found two schema-less auth tables **while boxing every table on one page**.
- #16 and #17 obsoleted part of the architecture **by compiling it and measuring
  the binary**.

And twice, the record corrected itself in public rather than quietly: #18
retracted its own blame of #14 the same day, and #17 reported that the spec was
stale *in our favour*.

The failure mode is the opposite one, and it is also in this record: a decision
frozen in an issue, a manifest that still says `proposed-not-active`, and a spec
that never learned about either.
