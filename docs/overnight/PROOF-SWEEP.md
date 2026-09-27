# Proof-integrity sweep of the claims added on 2026-09-27

**Date**: 2026-09-27 · slice `proof-sweep` · branch `v4/on-proof-sweep` · tree measured: `594df54`
(tree `a1ff626`, the same tree as main `5e890fe`, the merge of PR #127)
**Written by**: Claude Opus 5.5 (AI). No human has reviewed this sweep.

**Scope.** `git log --since='2026-09-27 00:00' --name-only -- docs app/docs/contracts AGENTS.md DESIGN.md app/README.md`.
Every hunk added after the AC audit (`cefc8db..594df54`) was read in full: `AC-MATRIX.md`, `AC-EVIDENCE.md`,
`FOREIGN-VISITOR.md`, the `PLAN.md` log, and the 2026-09-26/27 amendments in `search-chunk-v1.md` §21-§24,
`authorization-integration-v1.md` (three amendments), `chat-v1.md`, `read-cursor-v1.md`, `delivery-gates.md` and
`session-source-relic-v1.md`, plus the `AGENTS.md`, `DESIGN.md` and `app/README.md` diffs. The UI proof docs and
`PROOF.md` were sampled: every test-count claim that names a runnable file, and every `file:line`.

**Method.** A claim a command can check was checked on this tree. Test counts come from `bun test <file>` in
`app/server` (or `app/ui/v2`). `N/0` counts `test()` calls, preflight tests included, and never assertions. A false
or stale claim is corrected **in place**: the old value is kept, and a dated *sweep* note gives the new value. Nothing
was deleted. `PLAN.md` needed no correction line (see "Checked and true").

## 1. Corrections made

| # | Claim | File:line (doc) | Was | Now | Command |
|---|---|---|---|---|---|
| 1 | `/mcp/:bank/:workspace` returns 400 at `app.ts:233`; `params.bank` at `app.ts:212` | AC-MATRIX.md #31 bank row; AC-EVIDENCE.md §3 (`app.ts:145,212`) | `:233`, `:212` / `:145,212` | `app.ts:248-252`, `:227-228` / `:160,227-228` (PRs #124/#125 edited `app.ts`) | `rg -n '"/mcp/:bank"\|params.bank,\|/mcp/:bank/:workspace' app/server/src/app.ts` |
| 2 | `runMcp` uses `workspace` unchanged | AC-MATRIX.md #31 bank row; AC-EVIDENCE.md §3 | `auth/service.ts:322-350` | `:331-363` | `rg -n 'async runMcp\|kind: "workspace", workspace, action' app/server/src/auth/service.ts` |
| 3 | the single audit sink | AC-MATRIX.md #31 audit row | `auth/service.ts:188-213` | `appendAudit` `:179-205`; the one writer is `composition.ts:108` `composeAuditSink` | `rg -n 'async function appendAudit\|deps.logCall' app/server/src/auth/service.ts; rg -n composeAuditSink app/server/src/composition.ts` |
| 4 | no-leak test | AC-MATRIX.md #32 "no leak" row | `chat-coverage.test.ts:223` | `:266` | `rg -n 'recording stub saw only' app/server/test/chat-coverage.test.ts` |
| 5 | overflow and unauthorized-aggregate tests | AC-MATRIX.md #85 rows 2-3 | `chat-coverage.test.ts:205-219`, `:136-145,:195-203` | `:244-258`, `:175-183,:234-242` | `rg -n '^\s*test\(' app/server/test/chat-coverage.test.ts` |
| 6 | `chat-coverage` count | AC-MATRIX.md #32 and #85 rows | 17/0 (678 expects) | **26/0 (6076 expects)**. PR #124 added 9 live-transport tests | `bun test test/chat-coverage.test.ts` |
| 7 | label rendered as a `{value}` text child | AC-MATRIX.md #27 TODO 3; AC-EVIDENCE.md §4 | `VocabularyTable.tsx:33,49` | `:33,52`. `:49` is a lone `>`, and the file is unchanged since `cefc8db`, so the citation was wrong when written | `rg -n '\{value\}' app/ui/v2/src/components/VocabularyTable.tsx` |
| 8 | `.gitignore` names the code-intel database | AC-MATRIX.md #34 rev.2; AC-EVIDENCE.md §6 | `.gitignore:6` | `.gitignore:7-8` (a line was added above) | `rg -n -i 'code-intel\|codegraph' .gitignore` |
| 9 | the trace-cycle guard | AC-EVIDENCE.md §1 | `service.assertTraceChain.ts:20` | the guard is `:34`; `:20` is the function declaration | `rg -n 'seen.has' app/server/src/publication/service.assertTraceChain.ts` |
| 10 | Python cross-check of `proposed-not-active` | AC-EVIDENCE.md §3 | `test_target_schema_v1.py:114` | `:115` (`:114` asserts `registry_version`) | `rg -n proposed-not-active app/migrate-py/tests/test_target_schema_v1.py` |
| 11 | §6 area 3 batch | AC-EVIDENCE.md §6 table, row 3 | 27/0, 747 expects; budget at `chat-coverage.test.ts:209` | **36/0, 6145 expects** (the batch C row below); the budget assertion is `:248` | `bun test test/context-ownership.test.ts test/chat-coverage.test.ts` |
| 12 | "no other slice owns" the #28 AC1 literal test | FOREIGN-VISITOR.md §5 | not built | built by ac1-literal (`3b51a00`, PR #127): `association-ac1-literal.test.ts` 1/0 (81 expects) | `bun test test/association-ac1-literal.test.ts` |
| 13 | what `mcp_calls` records | AGENTS.md:21 (diagram) | "every admitted MCP call and HTTP kb call" | adds legacy HTTP memory-route calls. The old line contradicted AGENTS.md:38 and the code | `bun test test/transport-audit-legacy.test.ts` (3/0) |
| 14 | what §13 audit covers | DESIGN.md:1245 (built-vs-target table) | "MCP + /api/knowledge calls" | adds legacy `/api/memories`, `/api/search`, `/api/health`; not `/api/backfill` or `/api/reindex` (NEEDS-NAT) | same as 13; `rg -n '"/api/' app/server/src/app.ts` |
| 15 | CI has no lint step | AC-MATRIX.md #75 row 1, #34 row, C2 | absent | `.github/workflows/ci.yml:92-93` runs `uvx ruff@0.16.4 check app/migrate-py/src app/migrate-py/tests app/just/scripts` (PR #123). Locally: `All checks passed!` | `rg -n ruff .github/workflows/ci.yml` and the ruff command itself |
| 16 | "All 21 PARTIAL and 2 GAP rows" | AC-MATRIX.md §3 intro and coverage check | 21 | 21 at the audit, 20 after the ac-evidence fix round, **13 now**; annotated, not rewritten | roll-up arithmetic (§1 of AC-MATRIX.md) |
| 17 | round-level UI counts | UI-PROOF-ui-stale.md "Other checks"; UI-PROOF.md "Tests" | 48 total; `revisionDiff` 19; `chatError` 5 | 56 (13+30+13); 26; 8 (later rounds added tests) | `cd app/ui/v2 && bun test <files named in the doc>` |
| 18 | C5 "not verified here" | AC-MATRIX.md §5 C5 | unchecked | checked: `fts.constants.ts:9-12` says ngram 3..3 is character trigrams and the SDK refuses `trigram`/`unicode61`, so the two rows agree | `sed -n 9,12p app/server/src/fts/fts.constants.ts` |

**Row statuses re-scored (AC-MATRIX.md §1-§2), on evidence run by this sweep:**

| Row | Was | Now | Evidence (run on `594df54`) |
|---|---|---|---|
| #27 AC3 horizon changes nothing | PARTIAL | PASS | `taxonomy-horizon-reassign-ac3.test.ts` 1/0 (69); `taxonomy-horizon-reassign-ac3-permissions.test.ts` 1/0 (147) |
| #28 TODO foreign visitors | PARTIAL | PASS, with readings B/C as NEEDS-NAT (§4 item 11) | `relic-foreign-visitor.test.ts` 10/0 (24) |
| #28 AC1 (caveat) | PASS with caveat | PASS | `association-ac1-literal.test.ts` 1/0 (81) |
| #29 AC4 no decay, read-only reads | PARTIAL | PASS | `lifecycle-eligibility-ac4-schema.test.ts` 4/0 (6); `lifecycle-eligibility-ac4-readonly.test.ts` 1/0 (16) |
| #29 TODO self/cyclic supersede | PARTIAL | PASS | `lifecycle-supersede-self-cycle.test.ts` 1/0 (13); both cases are in one test, not two |
| #30 TODO partial coverage | PARTIAL | PASS | `search-chunk-retrieval-coverage.test.ts` 7/0 (101); `search-chunk-retrieval-candidate-ceiling.test.ts` 2/0 (49); `mcp-v3-search-wiring.test.ts` 24/0 (103); `mcp-v3-search.test.ts` 26/0 (304); `search-chunk-coverage-tie.test.ts` 1/0 (4); `cli-search.test.ts` 12/0 (34) |
| #31 audit across transports | PARTIAL | PARTIAL (the residual is now only the maintenance routes, NEEDS-NAT §4 item 10, draft PR #126) | `transport-audit-parity.test.ts` 2/0 (266); `transport-audit-refusals.test.ts` 2/0 (114); `transport-audit-legacy.test.ts` 3/0 (379). Each file's first test is a preflight |
| #75 independent re-certification | PARTIAL | PASS | `read-cursor-live-transport.test.ts` 2/0 (87; 1 preflight + 1 live test) |
| #75 row 1 root-level evidence | PARTIAL | PARTIAL (lint now evidenced; no CI verdict on HEAD) | ruff command above: `All checks passed!` |
| #85 acceptor re-certification | PARTIAL | PASS, with caveats: in-process route handlers, not TCP; largest case 7×51, not 9×51 | `chat-coverage.test.ts` 26/0 (6076) |
| #34 tests/typecheck/lint row | PARTIAL | PARTIAL (lint now evidenced locally; CI blocked) | ruff command above |

Roll-up: 73/20/2/5 became **80 PASS / 13 PARTIAL / 2 GAP / 5 SUPERSEDED** (100 rows). NEEDS-NAT went from 12 to 13. Two
§4 items were added: 10 (#31 maintenance-route audit home, draft PR #126) and 11 (#28 foreign-visitor readings B/C).
Items 1-9 are unchanged.

## 2. Checked and true (left untouched)

| Claim | File (doc) | Command | Result |
|---|---|---|---|
| `bun run test:mcp` 313 pass / 0 fail | search-chunk-v1.md §24 | `cd app/server && bun run test:mcp` | 313 pass / 0 fail, 1820 expects, 17 files |
| `bun run test:search-chunk` 157 pass / 0 fail across 22 files | search-chunk-v1.md §24 | `bun run test:search-chunk` | 157 pass / 0 fail, 3025 expects, 22 files |
| §21's coverage proof has 7 tests ("5 of 7 failed" red) | search-chunk-v1.md §21 | `bun test test/search-chunk-retrieval-coverage.test.ts` | 7/0 |
| `matchesShape` allows extra keys at `v3-compat-shapes.ts:231` | search-chunk-v1.md §22 | `sed -n 228,234p app/server/test/helpers/v3-compat-shapes.ts` | true (`:234` is the signature, `:231` the doc comment) |
| the tie test is outside the kernel-import guard's `TS_ROOT` | search-chunk-v1.md §24 | `rg -n 'TS_ROOT\s*=' app/migrate-py/tests/test_revision_v1.py` | `:436`, `server/src` only |
| 18-file read-cursor manifest (before/after blobs) | delivery-gates.md, fix-round amendment | `git diff-tree -r --no-commit-id da0f654^ da0f654`, compared hash by hash | 18/18 match |
| ac-evidence manifest blobs (`482e130`, fix round `b2171a0`, `b40a2ee` correction) | delivery-gates.md | `git rev-parse <commit>:<path>` for each row | all match |
| `delivery-gates.md:51` still cites `11cf723` | AC-MATRIX #75 | `sed -n 51p app/docs/contracts/delivery-gates.md` | true |
| writer 33 / reader 21 context methods; `context-ownership` 10/0 (69) | read-cursor-v1.md amendment; AC-EVIDENCE §5 | `bun test test/context-ownership.test.ts` | 10/0 (69) |
| `"42"` is `invalid_value`; wrong session is `invalid_reference` | read-cursor-v1.md amendment | `rg -n 'invalid_value\|invalid_reference' app/server/test/read-cursor-live-transport.test.ts` | true (`:195,:198`) |
| 205 and 307 budget entries | chat-v1.md amendment | `5*51-50`, `7*51-50` = `MIXED_BUDGET_ENTRIES` (`chat-coverage.test.ts:53`) | true |
| no `/api/stats` route; there are `/api/health`, `/api/memories`, `/api/search`, `/api/backfill`, `/api/reindex` | authorization-integration-v1.md, legacy-audit amendment | `rg -n '"/api/' app/server/src/app.ts` | true |
| GET `/api/memories` default 50; MCP `list_memories` default 20 | same | `rg -n 'limit' app/server/src/app.ts app/server/src/mcp/index.ts` | `app.ts:292-293`, `mcp/index.ts:169` |
| Overview subline "admitted MCP + HTTP calls · maintenance routes not logged" | same | `rg -n 'maintenance routes not logged' app/ui/v2/src/overview/OverviewView.tsx` | `:113` |
| one error-text function used by `runMcp`, the legacy routes and the kb audit | same | `rg -l auditErrorText app/server/src` | 4 files, as stated |
| FOREIGN-VISITOR §1-§2 citations: DESIGN.md:66-67, :91, :392, :415, :881, :1138; AGENTS.md:123; `relic.findSessions.ts:25`; `relic.rowToSessionRef.ts:29`; `evidence-v1.ts:51,:60-61`; `service.getContext.ts:34-47`; relic `cli.ts:59-61,:1306-1308`, `query.ts:1857` | FOREIGN-VISITOR.md; session-source-relic-v1.md | `sed -n <line>p <file>` for each | all true |
| `relic-foreign-visitor.test.ts` has 10 tests | same | `bun test test/relic-foreign-visitor.test.ts` | 10/0 (24) |
| mutant M2 (`bankFromRepo` keeps the whole `repo`) fails 2 tests, the `find` and `get` key-set tests | FOREIGN-VISITOR.md §3; session-source-relic-v1.md | replace `relic.bankFromRepo.ts`'s return with `return repo;`, run the file, then `git checkout --` the file | 8 pass / 2 fail, exactly those two tests; restored, then 10/0 and `git status` clean |
| `registry.ts:261-272` reads `listMcpCalls`/`listConnections` | AGENTS.md:38 | `sed -n 259,273p app/server/src/knowledge/registry.ts` | true |
| `KNOWLEDGE_METHODS` at `registry.ts:157` has 57 entries | AC-MATRIX #31 | `bun -e` over `Object.keys(KNOWLEDGE_METHODS).length` | 57 |
| `mcp/tools.ts:29` "planned, not implemented" | AC-MATRIX #27, §4 item 5 | `sed -n 29p app/server/src/mcp/tools.ts` | true |
| AC-EVIDENCE §1/§3 test-name citations: `createTrace.ts:195`, `relic-session-source.test.ts:119`, `contract-v1.test.ts:62`, `transport-ownership.test.ts:293`, `search-chunk-digest-boot.test.ts:244`, `target-schema-cross-language.test.ts:150`, `test_target_manifest.py:19`, `plan.py:98`, `taxonomy.requireLabel.ts:4-6` | AC-EVIDENCE.md | `sed -n <line>p` | all true |
| `trace-cycle-check.test.ts` 4/0, 14 expects | AC-EVIDENCE §1 | `bun test test/trace-cycle-check.test.ts` | 4/0 (14) |
| PLAN.md: #122 at 144 test files, #123 at 146, #124 at 154 | PLAN.md 16:54, 18:27, 18:58 | `git ls-tree -r --name-only <merge> app/server/test` plus `app/cli*.test.ts` | 144, 146, 154. The pass counts (2006, 2017, 2040) need the full suite, which this sweep may not run: **not re-checked** |
| PROOF.md §5: 36 tracked code files over 500 lines, all tests | PROOF.md §5 (measured on `d949290`) | `wc -l` over `git ls-files` code files, excluding the bundle | still 36, all tests, on `594df54` |
| `ui-e2e.test.ts` 9/0 | PLAN.md 15:51 | `cd app/server && bun test ../just/ui-e2e.test.ts` | 9/0 (46) |
| UI: `buildPublishInput.test.ts` 3 pass; `evidenceReview.test.ts` 22; `reflowText`+`a11yNames` 13 | UI-PROOF-ui-cite.md; UI-PROOF.md; UI-PROOF-ui-stale.md | `cd app/ui/v2 && bun test <file>` | 3, 22, 13 |

Batch re-runs of the AC-EVIDENCE commands are in §3.

**Not re-checked, and why.** Browser runs (`UI_E2E_RESULT`, screenshots, 812×375 measurements) need ego-browser on a
shared machine. The other mutant counts (for example "M1 fails 4") need source edits. The sweep spot-checked one (M2, above), restored it, and committed no product change. Acceptor
figures (`task9.md`, 146/0/1) live outside the repo; the live probe below re-measures them. Historical refutation
records that cite pre-fix code (for example UI-PROOF-ui-cite.md "`PublishForm.tsx:50`, `links: built.entries`") are
right about the code they describe, which was later extracted into `buildPublishInput.ts`.

## 3. Batch re-runs of the AC-EVIDENCE commands

Run in `app/server` on `594df54`, each command exactly as AC-EVIDENCE.md writes it.

| Batch | Command | AC-EVIDENCE claims | Measured now |
|---|---|---|---|
| A | `bun test test/replay-v1.test.ts test/search-chunk-digest-boot.test.ts test/search-chunk-digest-pin.test.ts` | 21/0, 179 expects | 21/0, 179 expects: true |
| B | `bun test test/evidence-v1.test.ts` | 11/0, 178 | 11/0, 178: true |
| C | `bun test test/context-ownership.test.ts test/chat-coverage.test.ts` | 27/0, 747 | **36/0, 6145: stale**, corrected (#11 above) |
| D | `bun test test/relic-session-source.test.ts` | 41/0, 71 | 41/0, 71: true |
| E | `bun test test/mcp-correctness.test.ts ../cli.test.ts` | 85/0, 380 | 85/0, 380: true |
| F | `bun test test/transport-ownership.test.ts test/search-chunk-digest-boot.test.ts test/target-schema-cross-language.test.ts test/contract-v1.test.ts` | 32/0, 354 | 32/0, 354: true |
| G | `bun run test:session-link` | 39/0, 348, 5 files | 39/0, 348, 5 files: true |
| H | `bun test test/revision-v1.test.ts test/*-ownership.test.ts` | 110/0, 1085, 12 files | 110/0, 1085, 12 files: true |

The Python guard (`cd app/migrate-py && PYTHONPATH=src .venv/bin/python -m unittest discover -s tests`) ran 271 tests:
`OK (skipped=1)`.

## 4. Live probe on this tree

- `bash .../live-probe/run.sh <this worktree> proof-sweep` exits **rc=2**. Methods 57, exposed HTTP 57 / MCP 57 /
  CLI 57, isolation **191 pass / 0 fail**, seed errors 0, fatal none, **payload gaps 26**. Every non-`--issues` run
  since 16:16 today reports the same 26 gaps ("no valid payload fixture"; for example `ac1-literal.md` and
  `chain-coverage.md`), so the 26 are the probe mode, not a regression.
- `... run.sh <this worktree> proof-sweep-issues --issues` exits **rc=2**. Payload gaps 0, isolation 191/0, and issue
  checks **146 PASS / 0 FAIL / 1 GAP**. The GAP is #33 browser evidence, skipped by design. Live #30 rows show
  `"coverage":"full","coverage_reason":null,"candidate_ceiling":4096` on HTTP and MCP answers.
