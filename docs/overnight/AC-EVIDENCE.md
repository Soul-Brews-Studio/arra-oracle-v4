# AC evidence: ac-evidence slice (2026-09-27)

Living evidence record for the `ac-evidence` slice (branch `v4/on-ac-evidence`), covering
the thin/PARTIAL rows of `docs/overnight/AC-MATRIX.md` §2 for issues #28, #31, #10, #27,
#75, #34. Every line below was actually run on this worktree today; nothing here is
carried over from `2d5ef44` or `cefc8db`'s prior evidence.

**Fix round (2026-09-27, same day).** An independent Opus verifier REFUTED the first pass
of this slice on six points. Fixed here, each cross-referenced at its section below:

1. `delivery-gates.md`'s manifest cited a nonexistent blob hash for `AC-MATRIX.md`'s
   "after" state — corrected below and in `delivery-gates.md`.
2. That manifest covered the `ac-evidence` slice's own 6 files, not the read-cursor
   slice (`da0f654`, 18 files) that issue #75's gap-list item 5 actually asked for — the
   real 18-file manifest is now appended to `delivery-gates.md` (§5 below).
3. §6 area 6 ("code-intel readiness") cited the wrong test — corrected in §6 below, and
   the #34 rev.2 row's PARTIAL->PASS flip is reverted in `AC-MATRIX.md`.
4. `AC-MATRIX.md`'s #28 TODO row claimed "Missing: none" while only the `parent_id`
   trace-cycle guard was tested, not the separate `prev_id` one — two new tests close
   this (§1 below).
5. The #28 AC3 "39/101" batch counts were wrongly called unreconstructable — they are
   reproducible; the real commands are recorded in §1 below.
6. Several nonblocking wording/citation fixes (§1, §5, §6).

---

## 1. #28 — revision-v1.test.ts, trace cycle-check, bounded excerpts, ownership batches

- **`revision-v1.test.ts` (C6):** run together with the full ownership batch below.
  Command: `bun test test/revision-v1.test.ts test/*-ownership.test.ts` (11 ownership
  files + revision-v1). **Decisive line: `110 pass / 0 fail`, 1085 expect() calls, 12
  files, 67.41s.** `revision-v1.test.ts` is real and passes; it was never "called passing
  with no run" again after this.
- **Trace cycle-check test (C6 "no file:line"):** none existed. Root cause: `service.
  assertTraceChain.ts` (`app/server/src/publication/service.assertTraceChain.ts:20`; *sweep 2026-09-27: `:20` is the
  function's declaration, and the guard itself is `:34`*) has
  had the guard (`seen.has(id)` -> `integrity_failure`) since #28 landed, but no test
  named it. **Written**, as a pin (the behaviour already exists) plus a manual mutation
  check: `app/server/test/trace-cycle-check.test.ts` (4 tests — a stored B<->C 2-cycle
  and a stored self-loop A->A over `parent_id`, then the same two shapes over `prev_id`,
  all planted via the existing `insertRawTrace` harness method because a well-behaved
  writer can never produce a stored cycle itself).
  - Pin run: `bun test test/trace-cycle-check.test.ts` -> **`4 pass / 0 fail`, 14
    expect() calls, ~3s.**
  - Mutation check (`parent_id`): commented out the `seen.has(id)` guard line in
    `service.assertTraceChain.ts`, reran the same file -> the two `parent_id` tests
    failed, both showing `code: "limit_exceeded"` instead of `"integrity_failure"` (the
    walk still terminates, at the 1024-hop bound, instead of catching the cycle
    immediately). Restored the original file (`git diff --stat` empty afterward) and
    reran -> back to `4 pass / 0 fail`.
  - **Fix-round mutation check (`prev_id`, 2026-09-27):** an independent verifier
    replaced the SEPARATE `prev_id` call site in `service.createTrace.ts:195`
    (`await assertTraceChain(writer, request.workspace_name, prev, "prev_id")`) with a
    no-op and reported that all existing trace tests, including the pin above, still
    passed — the first pass of this slice had pinned only the `parent_id` call site.
    Reproduced independently: applying the exact same no-op turned the two new
    `prev_id` tests red (`ok: true` instead of an `integrity_failure`) while the two
    `parent_id` tests stayed green, confirming the two call sites are independently
    guarded. Restored the original line and reran -> `4 pass / 0 fail` again.
- **Bounded-excerpt test (C6 "no evidence at all"):** exists and is named:
  `app/server/test/relic-session-source.test.ts:119`, `"read: turns map to bounded
  SourceExcerpts with speaker/content/sourceTime/eventSeq"`. Re-run as part of the
  ownership+revision batch above (`relic-session-source.test.ts` is not itself an
  ownership file, so it was also run standalone): `bun test
  test/relic-session-source.test.ts` -> **`41 pass / 0 fail`**, matching the separate
  110/0 batch, which also includes this file's tests.
- **AC3 batch commands (C7 "no row gives their commands"):** the matrix's original
  "39/101" counts are the per-category batches, not per-file. **Fix-round correction
  (2026-09-27):** an independent verifier reproduced them; this audit reproduced them
  again independently, with the exact commands:
  - `bun run test:session-link` (= `bun test test/session-link-*.test.ts`) -> **`39
    pass / 0 fail`, 348 expect() calls, 5 files, 31.58s.**
  - `bun test test/*-ownership.test.ts` (all 11 `*-ownership.test.ts` files) -> **`101
    pass / 0 fail`, 976 expect() calls, 11 files, 61.26s.**
  Both exactly match the matrix's original "39" and "101" figures. The first pass of
  this slice ran only two individual files (`session-link-ownership.test.ts` 6/0,
  `trace-ownership.test.ts` 5/0) and wrongly concluded the original batch counts
  "cannot be reconstructed" — that was the wrong granularity, not a real gap.

## 2. #10 — remaining ownership suites, re-run

Command: `bun test test/session-link-ownership.test.ts test/chat-ownership.test.ts
test/context-ownership.test.ts test/lifecycle-ownership.test.ts
test/publication-ownership.test.ts test/read-cursor-ownership.test.ts
test/search-chunk-ownership.test.ts test/taxonomy-ownership.test.ts
test/trace-ownership.test.ts test/transport-ownership.test.ts
test/association-ownership.test.ts test/revision-v1.test.ts` (all 11 `*-ownership.test.ts`
files plus `revision-v1.test.ts`, in one process).

**Decisive line: `110 pass / 0 fail`, 1085 expect() calls, across 12 files, 67.41s.**
Every ownership suite the #10 row named as "exists but not re-run" is now re-run, on
this worktree, today, 0 failures.

## 3. #31 — runtime schema validation, 409 conflict mapping, proposed-not-active object, bank normalization

- **Runtime schema validation (C9):** `app/server/test/contract-v1.test.ts:62`,
  `"closed message envelope rejects omission, extras, invalid strings and time"`.
- **409 conflict mapping (C9):** two distinct mappings, both named and run:
  - `app/server/test/transport-ownership.test.ts:293`, `"taxonomy conflict arrives as
    409, distinct from a server fault's 500"` (PR #96's mapping).
  - `app/server/test/search-chunk-digest-boot.test.ts:244`, `"HTTP maps it to 409 with
    the closed envelope plus both digests"` (R20 `embedding_profile_mismatch`).
- **Proposed-not-active contract object:** `app/server/test/target-schema-cross-language.
  test.ts:150`, `expect(golden.status).toBe("proposed-not-active")`, cross-checked against
  the Python side at `app/migrate-py/tests/test_target_manifest.py:19` and
  `test_target_schema_v1.py:114` *(sweep: the `proposed-not-active` assertion is `:115`; `:114` asserts `registry_version`)*.
  - Run: `bun test test/transport-ownership.test.ts test/search-chunk-digest-boot.test.ts
    test/target-schema-cross-language.test.ts test/contract-v1.test.ts` -> **`32 pass /
    0 fail`, 354 expect() calls, 4 files, 3.88s.**
- **`bank = workspaces.name` normalization (C8):** cited, not re-tested (no new test
  needed — this is a data-flow fact, not a behavior with its own assertion surface).
  Traced the literal parameter across three layers with no lookup/mapping table
  anywhere in between:
  - `app/server/src/app.ts:145,212` *(sweep 2026-09-27: now `:160,227-228`, after PRs #124/#125 edited `app.ts`)*: the route is `POST /mcp/:bank`; `params.bank` is
    passed as the FIRST positional argument straight into `mcpHandle(params.bank, ...)`.
  - `app/server/src/mcp/index.ts:224-246`: `createMcpAdapter`'s returned `handle`
    receives that value as its own `bank` parameter and passes it straight into
    `service.runMcp(authorization, bank, ...)`.
  - `app/server/src/auth/service.ts:322-350` *(sweep: now `:331-363`)*: `runMcp`'s second parameter is literally
    named `workspace`, and it is used unchanged as `{ kind: "workspace", workspace,
    action }` for admission — the same string, no lookup.
  There is no `workspaces` table join or rename step anywhere on this path: the bank
  segment of the URL IS `workspaces.name`, byte for byte.

## 4. #27 TODO 3 — label-as-data citation

No new test was written (the existing "0 `dangerouslySetInnerHTML`/`innerHTML` in
`app/ui/v2/src`" grep is real but was flagged "thin" because it is silence, not a
positive assertion). Stronger positive citation, found and read today:
`app/ui/v2/src/components/VocabularyTable.tsx:33,49` *(sweep 2026-09-27: the `{value}` cell is `:52`, not `:49`. `:49` is a JSX `>`. The file has not changed since `cefc8db`, so the citation was off when it was written)* — a vocabulary's `label` field
(the one taxonomy field the server explicitly allows arbitrary text in, with **no**
256-byte cap: `app/server/src/publication/taxonomy.requireLabel.ts:4-6`) is put into the
`rows` array and rendered at line 49 *(sweep: `:52`)* as `<td ...>{value}</td>` — a plain JSX text-child
interpolation. React always escapes text children; only `dangerouslySetInnerHTML` (found
nowhere in this tree) could turn a label into markup or a script. No dedicated
mount-and-assert UI test exists for this component; this remains a code-path citation,
not a live-rendered pin — recorded honestly as a smaller residual gap.

## 5. #75 — before/after manifest and read-cursor-v1.md amendment

- **Read-cursor-v1.md amendment:** appended (not edited) — see the
  `## Amendment 2026-09-26 (post-merge R7/R11/R17 + the audit's thin PASS rows)` section
  at the end of `app/docs/contracts/read-cursor-v1.md`. It states, in the contract's own
  words, that §1/§7/§8's "ten"/"five" (and the superseded "eight"/"four") were a snapshot
  of the context writer/reader facade's size at the moment THIS contract's §1 amendment
  landed, not a live ceiling this contract polices — the facade has grown since (current
  count below), and each later slice amends its own contract, not this one.
  - Current count, verified today: `bun test test/context-ownership.test.ts` ->
    **`10 pass / 0 fail`, 69 expect() calls, 11.82s** — pins the writer at 33 and the
    reader at 21 context methods (`context-ownership.test.ts:52-53`).
- **Before/after manifest, replacing `delivery-gates.md:51`'s stale `11cf723` snapshot:**
  `delivery-gates.md`'s "Latest verification scope" section still cites a commit
  (`11cf7235a815234d305f338982cf2cf53ef21197`, dated 2026-09-20) that predates the
  read-cursor slice's own commit (`da0f654`, 2026-09-21) — it is not evidence for that
  slice and never was. **First-pass mistake, corrected in the fix round (2026-09-27):**
  the first pass of this slice appended a manifest of the `ac-evidence` slice's OWN 6
  changed files (this slice's docs/tests) — real hashes, but the wrong slice; it says
  nothing about the read-cursor slice's actual 18 changed files, which is what issue
  #75's reopen comment and gap-list item 5 asked for. An independent verifier correctly
  flagged this as misleading even though the row stayed PARTIAL.
  - **Fix-round manifest:** `delivery-gates.md` now also carries the READ-CURSOR
    slice's own before/after per-path blob-hash table — before = the blob at
    `da0f654^` (`d42ee3e`, the PR #70 merge it landed on), after = the blob at `da0f654`
    itself — for all 18 files `git diff --stat da0f654^ da0f654` names, generated with
    `git diff-tree -r --no-commit-id da0f654^ da0f654` (which prints both blob hashes
    directly, no working-tree round trip). This is the manifest gap-list item 5 asked
    for; the `ac-evidence` slice's own 6-file manifest remains, but is now labelled as
    evidence for THIS slice's own changes only, not for #75.

## 6. #34 rev.2 — release-audit table and vector_disposition test

Six areas named by the rev.2 release audit (issue #34's own text: "Release audit includes
message replay/digest conflicts, evidence-key equality, context budgets, passive locator
security, MCP CLI error exits and measured code-intelligence readiness where used"). None
of them had a *consolidated* audit document; all six mechanisms exist and are named here
by test, file and line. **Fix round (2026-09-27):** five of the six are re-run today with
correct citations; area 6 ("code-intel readiness") is corrected to the right citation
(issue #37's Serena/CodeGraph dev-tooling, not migration readback) but is historical
evidence, not re-run today — see the table's own note.

| # | Rev-2 area | Test(s), by name | Run today | Result |
|---|---|---|---|---|
| 1 | Replay / digest conflicts | `app/server/test/replay-v1.test.ts`; `app/server/test/search-chunk-digest-boot.test.ts` (R20 `embedding_profile_mismatch` -> 409); `app/server/test/search-chunk-digest-pin.test.ts` | `bun test test/replay-v1.test.ts test/search-chunk-digest-boot.test.ts test/search-chunk-digest-pin.test.ts` | **21 pass / 0 fail, 179 expect() calls, 3 files, 11.46s** |
| 2 | Evidence-key equality | `app/server/test/association-query.test.ts:718` ("two capture digests at one location are two targets; a changed title is one"); `app/server/test/evidence-v1.test.ts` | `bun test test/evidence-v1.test.ts` | **11 pass / 0 fail, 178 expect() calls, 16ms** |
| 3 | Context method-count pin + wire-byte budget | `app/server/test/context-ownership.test.ts` (facade/method-count PIN, not a budget — see note below); `app/server/test/chat-coverage.test.ts` (`MAX_CONTEXT_ITEMS`/`MAX_CONTEXT_WIRE_BYTES` overflow, 5x51 — the actual budget, `chat-coverage.test.ts:209` *(sweep: now `:248`)*) | `bun test test/context-ownership.test.ts test/chat-coverage.test.ts` | **27 pass / 0 fail, 747 expect() calls, 2 files, 27.70s** *(sweep 2026-09-27: the same command on `594df54` gives a different count, recorded in `docs/overnight/PROOF-SWEEP.md`. PR #124 added 9 live-transport tests to `chat-coverage.test.ts`)* |
| 4 | Passive locator security | `app/server/src/publication/trace.types.ts:28` ("never dereferenced", no dereference code exists — `rg` confirms); `app/server/test/relic-session-source.test.ts` (bounded excerpts, no whole-transcript read) | `bun test test/relic-session-source.test.ts` | **41 pass / 0 fail, 71 expect() calls, 1.33s** |
| 5 | MCP CLI error exits | `app/server/test/mcp-correctness.test.ts`; `../cli.test.ts` (nonzero exit codes, per R8) | `bun test test/mcp-correctness.test.ts ../cli.test.ts` | **85 pass / 0 fail, 380 expect() calls, 2 files, 2.44s** |
| 6 | Code-intel readiness (Serena/CodeGraph MCP dev-tooling, issue #37 — **corrected in the fix round**; NOT migration readback) | `app/docs/verification/2026-09-20-foundation.md`; issue #37 comments 2026-09-20 (Serena 23 tools, CodeGraph 21 tools, index 61 files/621 nodes/1432 edges, all 61 SHA256 hashes verified) | none today — historical evidence only | **Not re-run in this slice.** The prior version of this row cited `app/migrate-py/tests/test_copy_migration.py::test_ts_kernel_reads_every_migrated_node_back`, which measures migration read-back correctness, not dev-tooling readiness — a wrong citation an independent verifier caught (issue #34's own wording is "measured code-intelligence readiness **where used**", and `.gitignore:6` *(sweep 2026-09-27: now `.gitignore:7-8`)* names `/.codegraph/` "code-intelligence database"). That test remains good evidence for AC1/AC4 elsewhere in this matrix; it is removed from this area. |

**Area 6 re-run live (2026-09-28 03:15 +07, on `aff292a`, the main checkout):** the result is
**partial readiness, measured**.

- **CodeGraph:** `codegraph_stats` answers 1236 files, 21661 nodes, 81237 edges and 7
  unresolved refs. `git ls-files` counts 1239 tracked `.ts/.tsx/.py` files.
- **Call sites and definitions:** `codegraph_search createApp` returns call sites
  (`auth-transport.test.ts:97` and others). It does **not** return the definition,
  `export function createApp` at `app/server/src/app.ts:101`, even though `rg` finds it
  there. Code intelligence is usable for finding callers, but a definition lookup can miss.
  Confirm definitions with `rg`.
- **Serena:** `find_symbol getContext` (scoped to `app/server/src`) did not answer
  within 120 s, was moved to the background, and then failed: `Tool execution timed out after
  240 seconds`. Serena symbol lookup is **not ready** in this repo today.

Code intelligence is dev tooling only. No product path depends on it, so this row is
evidence of "readiness where used" and its limits, not a release blocker.

- **Dedicated `vector_disposition` / never-reused test (#34 TODO 3 caveat):** written —
  `app/migrate-py/tests/test_copy_migration.py::
  test_vector_disposition_never_reuses_a_legacy_vector_across_every_migrated_node`.
  Whole-fixture (all 10 migrated nodes, not the one node the smoke test happens to read):
  pins that exactly 1 of 10 migrated first-revisions is labelled `rebuild_unknown_profile`
  (the one legacy memory that actually had a vector) and the other 9 are labelled `none`
  (nothing to discard) — and, independent of the label, that **all 10** derived
  `search_chunks_v1` rows are `status="pending"` with a **null** `embedding`, 0 attempts,
  no `embedded_at`. Failing-first was not applicable (the guard code already existed);
  this is a pin. **Mutation check performed:** changed `plan.py:98` to always emit
  `"none"` -> reran the new test alone -> **1 fail** (`AssertionError`: expected one
  `rebuild_unknown_profile`, got ten `none`s). Restored the original line (`git diff
  --stat` empty afterward) and reran -> green again.

## 7. Full run log for §6 (today, this worktree)

```
$ bun test test/replay-v1.test.ts test/search-chunk-digest-boot.test.ts test/search-chunk-digest-pin.test.ts
$ bun test test/evidence-v1.test.ts
$ bun test test/context-ownership.test.ts test/chat-coverage.test.ts
$ bun test test/relic-session-source.test.ts
$ bun test test/mcp-correctness.test.ts ../cli.test.ts
$ (cd app/migrate-py && PYTHONPATH=src .venv/bin/python -m unittest tests.test_copy_migration -v)
```

See the commit for this slice for the exact terminal output; the decisive pass/fail
counts are folded into the roll-up in `docs/overnight/AC-MATRIX.md` where each row's
status changed on the strength of this evidence.
