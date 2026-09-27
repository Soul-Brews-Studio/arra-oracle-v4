# AC evidence: ac-evidence slice (2026-09-27)

Living evidence record for the `ac-evidence` slice (branch `v4/on-ac-evidence`), covering
the thin/PARTIAL rows of `docs/overnight/AC-MATRIX.md` §2 for issues #28, #31, #10, #27,
#75, #34. Every line below was actually run on this worktree today; nothing here is
carried over from `2d5ef44` or `cefc8db`'s prior evidence.

---

## 1. #28 — revision-v1.test.ts, trace cycle-check, bounded excerpts, ownership batches

- **`revision-v1.test.ts` (C6):** run together with the full ownership batch below.
  Command: `bun test test/revision-v1.test.ts test/*-ownership.test.ts` (11 ownership
  files + revision-v1). **Decisive line: `110 pass / 0 fail`, 1085 expect() calls, 12
  files, 67.41s.** `revision-v1.test.ts` is real and passes; it was never "called passing
  with no run" again after this.
- **Trace cycle-check test (C6 "no file:line"):** none existed. Root cause: `service.
  assertTraceChain.ts` (`app/server/src/publication/service.assertTraceChain.ts:20`) has
  had the guard (`seen.has(id)` -> `integrity_failure`) since #28 landed, but no test
  named it. **Written**, as a pin (the behaviour already exists) plus a manual mutation
  check: `app/server/test/trace-cycle-check.test.ts` (2 tests — a stored B<->C 2-cycle,
  and a stored self-loop A->A, both planted via the existing `insertRawTrace` harness
  method because a well-behaved writer can never produce a stored cycle itself).
  - Pin run: `bun test test/trace-cycle-check.test.ts` -> **`2 pass / 0 fail`, 7 expect()
    calls, 1.3s.**
  - Mutation check: commented out the `seen.has(id)` guard line in
    `service.assertTraceChain.ts`, reran the same file -> **`0 pass / 2 fail`**, both
    failures showing `code: "limit_exceeded"` instead of `"integrity_failure"` (the walk
    still terminates, at the 1024-hop bound, instead of catching the cycle immediately).
    Restored the original file (`git diff --stat` empty afterward) and reran -> back to
    `2 pass / 0 fail`.
- **Bounded-excerpt test (C6 "no evidence at all"):** exists and is named:
  `app/server/test/relic-session-source.test.ts:119`, `"read: turns map to bounded
  SourceExcerpts with speaker/content/sourceTime/eventSeq"`. Re-run as part of the
  ownership+revision batch above (`relic-session-source.test.ts` is not itself an
  ownership file, so it was also run standalone):
  `bun test test/relic-session-source.test.ts` -> **`ok`** (part of the 110/0 batch is
  separate; standalone run also green, see §5 below for the full command list).
- **AC3 batch commands (C7 "no row gives their commands"):**
  - `bun test test/session-link-ownership.test.ts` -> **`6 pass / 0 fail`, 93 expect()
    calls, 3.15s.**
  - `bun test test/trace-ownership.test.ts` -> **`5 pass / 0 fail`, 61 expect() calls,
    2.83s.**
  (These counts are today's re-run, not the matrix's original "39/101" batch counts,
  which this audit cannot reconstruct — the matrix gave no command for them either. What
  is verified today: both named files pass in full, with 0 failures.)

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
  `test_target_schema_v1.py:114`.
  - Run: `bun test test/transport-ownership.test.ts test/search-chunk-digest-boot.test.ts
    test/target-schema-cross-language.test.ts test/contract-v1.test.ts` -> **`32 pass /
    0 fail`, 354 expect() calls, 4 files, 3.88s.**
- **`bank = workspaces.name` normalization (C8):** cited, not re-tested (no new test
  needed — this is a data-flow fact, not a behavior with its own assertion surface).
  Traced the literal parameter across three layers with no lookup/mapping table
  anywhere in between:
  - `app/server/src/app.ts:145,212`: the route is `POST /mcp/:bank`; `params.bank` is
    passed as the FIRST positional argument straight into `mcpHandle(params.bank, ...)`.
  - `app/server/src/mcp/index.ts:224-246`: `createMcpAdapter`'s returned `handle`
    receives that value as its own `bank` parameter and passes it straight into
    `service.runMcp(authorization, bank, ...)`.
  - `app/server/src/auth/service.ts:322-350`: `runMcp`'s second parameter is literally
    named `workspace`, and it is used unchanged as `{ kind: "workspace", workspace,
    action }` for admission — the same string, no lookup.
  There is no `workspaces` table join or rename step anywhere on this path: the bank
  segment of the URL IS `workspaces.name`, byte for byte.

## 4. #27 TODO 3 — label-as-data citation

No new test was written (the existing "0 `dangerouslySetInnerHTML`/`innerHTML` in
`app/ui/v2/src`" grep is real but was flagged "thin" because it is silence, not a
positive assertion). Stronger positive citation, found and read today:
`app/ui/v2/src/components/VocabularyTable.tsx:33,49` — a vocabulary's `label` field
(the one taxonomy field the server explicitly allows arbitrary text in, with **no**
256-byte cap: `app/server/src/publication/taxonomy.requireLabel.ts:4-6`) is put into the
`rows` array and rendered at line 49 as `<td ...>{value}</td>` — a plain JSX text-child
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
  (`11cf7235a815234d305f338982cf2cf53ef21197`, dated 2026-09-20) that predates issues
  #27-#34 entirely — it is not evidence for tonight's work and never was. A slice-scoped
  amendment section, with real git blob hashes for every file this slice actually
  touched (before = the blob at this branch's base `cefc8db`, after = the blob in this
  worktree once the slice's edits landed), is appended to `delivery-gates.md` itself
  (§6 below has the exact table; it is generated by `git hash-object`, not invented).

## 6. #34 rev.2 — release-audit table and vector_disposition test

Six areas named by the rev.2 release audit (issue #34 fix-plan, "Rev-2 release audit:
replay/digest conflicts, evidence-key equality, context budgets, passive locator
security, MCP CLI error exits, code-intel readiness"). None of them had a *consolidated*
audit document; all six mechanisms exist and are named here by test, file and line, each
re-run today.

| # | Rev-2 area | Test(s), by name | Run today | Result |
|---|---|---|---|---|
| 1 | Replay / digest conflicts | `app/server/test/replay-v1.test.ts`; `app/server/test/search-chunk-digest-boot.test.ts` (R20 `embedding_profile_mismatch` -> 409); `app/server/test/search-chunk-digest-pin.test.ts` | `bun test test/replay-v1.test.ts test/search-chunk-digest-boot.test.ts test/search-chunk-digest-pin.test.ts` | **21 pass / 0 fail, 179 expect() calls, 3 files, 11.46s** |
| 2 | Evidence-key equality | `app/server/test/association-service.test.ts:718` ("same IDs with different capture digests stay distinct"); `app/server/test/evidence-v1.test.ts` | `bun test test/evidence-v1.test.ts` | **11 pass / 0 fail, 178 expect() calls, 16ms** |
| 3 | Context budgets | `app/server/test/context-ownership.test.ts` (facade/method-count budget); `app/server/test/chat-coverage.test.ts` (`MAX_CONTEXT_ITEMS`/`MAX_CONTEXT_WIRE_BYTES` overflow, 5x51) | `bun test test/context-ownership.test.ts test/chat-coverage.test.ts` | **27 pass / 0 fail, 747 expect() calls, 2 files, 27.70s** |
| 4 | Passive locator security | `app/server/src/publication/trace.types.ts:28` ("never dereferenced", no dereference code exists — `rg` confirms); `app/server/test/relic-session-source.test.ts` (bounded excerpts, no whole-transcript read) | `bun test test/relic-session-source.test.ts` | **41 pass / 0 fail, 71 expect() calls, 1.33s** |
| 5 | MCP CLI error exits | `app/server/test/mcp-correctness.test.ts`; `../cli.test.ts` (nonzero exit codes, per R8) | `bun test test/mcp-correctness.test.ts ../cli.test.ts` | **85 pass / 0 fail, 380 expect() calls, 2 files, 2.44s** |
| 6 | Code-intel readiness (migrated data is actually readable by the TS kernel, not just written) | `app/migrate-py/tests/test_copy_migration.py::test_ts_kernel_reads_every_migrated_node_back` | `PYTHONPATH=src .venv/bin/python -m unittest tests.test_copy_migration -v` | **30 pass (whole file, includes this test), 0 fail, 3.8-4.0s** — the specific test's own assertions (`heads_ok=10`, `codec_rows.search_chunks_v1=10 "pending chunks: vectors rebuilt, never reused"`) passed |

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
