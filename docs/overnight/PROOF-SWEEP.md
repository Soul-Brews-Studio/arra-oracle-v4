# Proof-integrity sweep of the claims added on 2026-09-27

**Date**: 2026-09-27 · slice `proof-sweep` · branch `v4/on-proof-sweep` · tree measured: `594df54`
(tree `a1ff626`, the same tree as main `5e890fe`, the merge of PR #127)
**Written by**: Claude Opus 5.5 (AI). No human has reviewed this sweep.

**Scope.** `git log --since='2026-09-27 00:00' --name-only -- docs app/docs/contracts AGENTS.md DESIGN.md app/README.md`
lists 31 `.md` files on `594df54` (32 on `81fe34b`, which adds this file).

*Fix round (2026-09-27, after an independent verifier refuted the first pass).* The first pass did **not** cover
that whole scope, and said so only here, not in its report. It read the hunks added after the AC audit
(`cefc8db..594df54`) by hand, listed below, and skipped the earlier 2026-09-27 hunks in `AGENTS.md` and
`app/README.md`, which is where nine stale citations sat. The fix round added two passes over **every line
`git blame` dates to 2026-09-27, in all 32 files**:

- a citation pass: `python3 docs/overnight/proof-sweep-drift.py 81fe34b` resolves 240 `file:line` citations
  (including bare `` `:N` `` after a file) and compares each cited line as it stood when the doc line was written
  with the line on the tree. It found 16 drifted citations plus 3 known ones (§1a). Every citation it reports was
  also opened by hand.
- a count pass: every such line in the files the first pass had not read (`lifecycle-v1.md`, `trace-v1.md`,
  `taxonomy-write-v1.md`, `context-ingestion-v1.md`, `revision-evidence-v1.md`, `revision-publication-v1.md`,
  `docs/SCHEMA-BUILT.md`, `DECISIONS.md`, `UI-E2E.md`, `V3-PARITY.md`, `DEMO.md`) that states a test count
  (`N pass`, `N/0`, `N tests`, `OK`, `N expect`) was listed: 27 lines. The re-runnable ones were re-run (§1a,
  §2); the rest are browser or live-Honcho runs (§2, "Not re-checked").

The fix round then read by hand every 2026-09-27 line of `revision-publication-v1.md` (25 lines),
`taxonomy-write-v1.md` (54), `revision-evidence-v1.md` (53) and `V3-PARITY.md` (1), plus every 2026-09-27 line of
`docs/SCHEMA-BUILT.md` that holds a number (rows 40-42 came from this). The remaining prose of `DEMO.md` (1,050
lines dated today), `lifecycle-v1.md` (410), `UI-E2E.md` (400), `context-ingestion-v1.md` (153), `DECISIONS.md` (53)
and `trace-v1.md` (47) got only the citation and count passes, and **was not read by hand**. Neither were the
`PLAN.md` log hunks written before `cefc8db`, beyond the counts §2 lists. (Line counts:
`git blame --line-porcelain 81fe34b -- <file>`, lines whose committer date is 2026-09-27 GMT+7.)

First pass, read by hand in full: `AC-MATRIX.md`, `AC-EVIDENCE.md`,
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
| 1 | `/mcp/:bank/:workspace` returns 400 at `app.ts:233`; `params.bank` at `app.ts:212` | AC-MATRIX.md #31 bank row; AC-EVIDENCE.md §3 (`app.ts:145,212`) | `:233`, `:212` / `:145,212` | `app.createApp.ts:249-254`, `:228-229` / `:163,228-229` (PRs #124/#125 edited `app.ts`; re-pin 2026-09-28: `app.ts` split into `app.createApp.ts` by PR #147) | `rg -n '"/mcp/:bank"\|params.bank,\|/mcp/:bank/:workspace' app/server/src/app.createApp.ts` |
| 2 | `runMcp` uses `workspace` unchanged | AC-MATRIX.md #31 bank row; AC-EVIDENCE.md §3 | `auth/service.ts:322-350` | `service.createOperationService.ts:330-362` (re-pin 2026-09-28: `service.ts` split into `service.createOperationService.ts` by PR #147) | `rg -n 'async runMcp\|kind: "workspace", workspace, action' app/server/src/auth/service.createOperationService.ts` |
| 3 | the single audit sink | AC-MATRIX.md #31 audit row | `auth/service.ts:188-213` | `appendAudit` `service.createOperationService.ts:183-209`; the one writer is `composition.ts:108` `composeAuditSink` (re-pin 2026-09-28: `service.ts` split into `service.createOperationService.ts`) | `rg -n 'async function appendAudit\|deps.logCall' app/server/src/auth/service.createOperationService.ts; rg -n composeAuditSink app/server/src/composition.ts` |
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
| 16 | "All 21 PARTIAL and 2 GAP rows" | AC-MATRIX.md §3 intro and coverage check | 21 | 21 at the audit, 20 after the ac-evidence fix round, **14 now** (driver correction 2026-09-27: a Python parse of each AC-MATRIX §2 status cell gives 79 PASS / 14 PARTIAL / 2 GAP / 5 SUPERSEDED, matching this file's roll-up line and AC-MATRIX.md:218); annotated, not rewritten | roll-up arithmetic (§1 of AC-MATRIX.md) |
| 17 | round-level UI counts | UI-PROOF-ui-stale.md "Other checks"; UI-PROOF.md "Tests" | 48 total; `revisionDiff` 19; `chatError` 5 | 56 (13+30+13); 26; 8 (later rounds added tests) | `cd app/ui/v2 && bun test <files named in the doc>` |
| 18 | C5 "not verified here" | AC-MATRIX.md §5 C5 | unchecked | checked: `fts.constants.ts:9-12` says ngram 3..3 is character trigrams and the SDK refuses `trigram`/`unicode61`, so the two rows agree | `sed -n 9,12p app/server/src/fts/fts.constants.ts` |

### 1a. Fix-round corrections (2026-09-27)

Red first: `python3 docs/overnight/proof-sweep-check.py 81fe34b` (the docs as the first pass committed them) gave
**0 ok / 30 fail** on its first 30 rows, and `python3 docs/overnight/proof-sweep-drift.py 81fe34b` gave **16 drifted**.
Its last 10 rows pin this file's own locators into AGENTS.md; with `b8199a3`'s AGENTS.md (a three-line diagram
wrap, row 39) they gave 9 fail. On the final commit: **40 ok / 0 fail**, and drift reports 0 drifted, with the 3
known citations and this file's AGENTS.md locators listed as KNOWN (the locators are pinned by the check). Rows 19-30 are the 16 drifted citations (a row
covers every doc that carried it); 32-33 are the 3 known ones in frozen contracts; 31 and 34-42 come from the count
pass, a hand read of the smaller unread contracts, and the verifier's non-blocking findings.

| # | Claim | File:line (doc) | Was | Now | Command |
|---|---|---|---|---|---|
| 19 | HTTP kb cap 1 MiB | AGENTS.md:40 | `knowledge/transport.ts:67` (a blank line) | `:69` | `rg -n 'MAX_KNOWLEDGE_REQUEST_BYTES =' app/server/src/knowledge/transport.ts` |
| 20 | 8 memory tools + 57 `kb_*` | AGENTS.md:44 | `mcp/tools.ts:16,171,191` | `:18,181,201` (`KNOWLEDGE_TOOLS`, `TOOLS`). Right on `e00b50b`; PR #125 moved them. The verifier's list missed this one (re-pin 2026-09-28: two lines added above shifted `tools.ts`) | `rg -n 'export const (MEMORY_TOOLS\|KNOWLEDGE_TOOLS\|TOOLS) ' app/server/src/mcp/tools.ts` |
| 21 | v3-compat flag is exactly `1` | AGENTS.md:45; app/README.md:205 | `composition.ts:199-201` (`logCall: await composeAuditSink()`) | `:242-243` (`composeV3Compat`) (re-pin 2026-09-28: `composition.ts` grew above this function) | `rg -n 'ARRA_MCP_V3_COMPAT ===' app/server/src/composition.ts` |
| 22 | `X-Arra-Peer` read only with the flag | AGENTS.md:53 | `app.ts:157` (an `// -- MCP --` comment) | `app.createApp.ts:175` (re-pin 2026-09-28: `app.ts` split into `app.createApp.ts` by PR #147) | `rg -n 'x-arra-peer' app/server/src/app.createApp.ts` |
| 23 | Host/Origin gate on every request | AGENTS.md:85; app/README.md:142 | `app.ts:137-140` (`bodyGate`) | `app.createApp.ts:155-157` (`onRequest` + `checkHostAndOrigin`) (re-pin 2026-09-28: `app.ts` split into `app.createApp.ts`) | `rg -n 'onRequest\|checkHostAndOrigin\(' app/server/src/app.createApp.ts` |
| 24 | binds only `127.0.0.1` | AGENTS.md:85 | `index.ts:92-96` | `:95-99` (`app.listen`, `hostname` at `:97`) | `rg -n 'hostname: "127' app/server/src/index.ts` |
| 25 | `/health` skips admission | AGENTS.md:87 | `app.ts:243` (`},`) | `app.createApp.ts:259` (re-pin 2026-09-28: `app.ts` split into `app.createApp.ts`) | `rg -n '"/health"' app/server/src/app.createApp.ts` |
| 26 | static UI skips admission | AGENTS.md:87; app/README.md:143 | `app.ts:429-458` (the `/api/backfill` handler) | `app.createApp.ts:471-500` (`options.assets` + `staticPlugin`) (re-pin 2026-09-28: `app.ts` split into `app.createApp.ts`; instance-audit route added above shifted it further) | `rg -n 'options.assets' app/server/src/app.createApp.ts; wc -l app/server/src/app.createApp.ts` |
| 27 | `?bank` parsed | AGENTS.md:98; app/README.md:152 | `app.ts:79-85` (`positiveInt`) | `app.createApp.ts:96-102` (`bankParam`) (re-pin 2026-09-28: `app.ts` split into `app.createApp.ts`) | `rg -n 'const bankParam' app/server/src/app.createApp.ts` |
| 28 | `/api/health` 400 before admission | AGENTS.md:98; app/README.md:153 | `:253-259` | `:268-273` | `sed -n 268,273p app/server/src/app.ts` |
| 29 | the 400 is pinned | AGENTS.md:98; app/README.md:154 | `mcp-correctness.test.ts:435-437` (`:435` blank; the file is unchanged since `cefc8db`, so this was off by one when written) | `:467-470` (re-pin 2026-09-28: unrelated test additions earlier in the file shifted it) | `sed -n 467,470p app/server/test/mcp-correctness.test.ts`; `bun test test/mcp-correctness.test.ts` |
| 30 | `attribution_unresolved` asserted | AC-MATRIX.md #34 "reuse vectors" row | `test_copy_migration.py:205` (a docstring) | `:244`; ruff/isort in PR #123 (`14ebc7e`, `b8ff103`) moved it. The file runs 30 tests, OK | `rg -n attribution_unresolved app/migrate-py/tests/test_copy_migration.py` |
| 31 | the R4 amendment | AC-MATRIX.md #32 R4 row | `chat-v1.md:242-319` | `:242-314`; `:315` starts the R9 amendment | `rg -n '^## Amendment' app/docs/contracts/chat-v1.md` |
| 32 | "the name stays the immutable identity" | context-ingestion-v1.md:233 (frozen) | `DESIGN.md:369` | `:371`; appended a PROOF.md-rule amendment, original text kept | `rg -n 'display title = optional metadata' DESIGN.md` |
| 33 | "stale vectors never present superseded content" | search-chunk-v1.md:278, §12 (frozen) | `DESIGN.md:1119` (`:1121` when written) | `:1125`; appended §25, original text kept | `rg -n 'stale vectors never present' DESIGN.md` |
| 34 | UI calls 30 of 57 methods, neither search method; `bun test` 106/0 across 9 files | AGENTS.md:108 | true on `e00b50b` only | 36 of 57 names match, 34 real calls (2 note-text false positives, row 42), both `searchKnowledgeKeyword` and `searchKnowledgeSemantic` called; 408/0 across 67 files. Annotated in place | `cd app/ui/v2 && bun test`; the scan is below |
| 35 | `bun test test/lifecycle-*.test.ts` 35/0, 416 expects | lifecycle-v1.md §18 (frozen) | true for that split | 41/0, 451 expects, 12 files (PR #124 added 3 files); appended §19 | `cd app/server && bun test test/lifecycle-*.test.ts` |
| 36 | `oracle_search`/`oracle_ask` fold partial coverage into `compat_warnings` | app/README.md:252 | incomplete: omitted `oracle_search_chain` | adds `oracle_search_chain`, OR-ed across hops (§24, PR #127) | `sed -n 81p app/server/src/mcp/legacy-v3/tools/oracle_search_chain.ts` |
| 37 | round-level `actionStale` "9 pass" | UI-PROOF-ui-stale.md:616 | not annotated | annotated: 13 on `594df54` | `cd app/ui/v2 && bun test ./src/state/actionStale.test.tsx` |
| 38 | #85 re-check "not from the Codex acceptor" | AC-MATRIX.md #85 caveat | stale (a race) | the acceptor re-ran it too: `TASK-10-REPORT.md:16,23` (untracked, overnight worktree), 32/0, 6108 expects, "#85 DONE" | `rg -n '#85' <overnight wt>/.tmp/acceptor/live-probe/TASK-10-REPORT.md` |
| 39 | AGENTS.md header and diagram | AGENTS.md:3-7, :21 | Version not bumped by the first pass; `:21` was 145 chars wide | Version bumped with a sweep line; `:21-22` rewrapped in place to 111 and 112 columns (on `594df54` line 21 was 114). It stays two lines: a three-line wrap shifted every later AGENTS.md line by one and broke `AGENTS.md:38`, `:122` and `:123` in AC-MATRIX, FOREIGN-VISITOR and this file, which `proof-sweep-drift.py` caught before the fix round was done | `awk 'NR>=15&&NR<=32{print length}' AGENTS.md` |
| 40 | the v3 `publish()` "does not call `reconcileRevisionAssociations`" | taxonomy-write-v1.md:229 (frozen) | true on its own branch (`dd478f8`) | false after the merge: opt-in `reconcile` at `publish.ts:110-118`, set only by `oracle_trace_distill.ts:88` (`61dd298`, a parallel branch). K6's conclusion holds. Appended an amendment | `rg -n 'reconcile: true\|input.reconcile' app/server/src/mcp/legacy-v3`; `git merge-base --is-ancestor 61dd298 dd478f8` (exit 1) |
| 41 | `revision_v1.py` "is now 465 lines" | revision-evidence-v1.md:268 (frozen) | 465 (true at `4056d9b`) | 461, already when `4e90ba8` wrote the sentence, and on `594df54`. Appended an amendment | `wc -l app/migrate-py/src/arra_migrate/revision_v1.py` |
| 42 | UI scan: 145 files / 116 non-test, 33 names matched, `listSearchChunks`/`getSearchFreshness` absent | SCHEMA-BUILT.md, round-4 paragraph | true for round 4 | 208 / 141, 36 matched, 34 real calls; `listSearchChunks` (`api/listSearchChunks.ts:19`) and `getSearchFreshness` (`api/getSearchFreshness.ts:21`) are called; `embedPendingChunks` is a note-text false positive (`state/searchFreshnessView.ts:104`). A dated paragraph was added above round 4 | `git ls-tree -r --name-only 594df54 -- app/ui/v2/src \| wc -l`; `rg -n '\b(listSearchChunks\|getSearchFreshness\|embedPendingChunks)\b' -g '!*.test.*' app/ui/v2/src` |

The UI scan in row 34: for each `KNOWLEDGE_METHODS` name, a word match against the non-test `.ts`/`.tsx` under
`app/ui/v2/src` with `/* */` and `//` comments removed, at each revision. `e00b50b`: 30 of 57, no search method (the
AGENTS.md figure, reproduced). `594df54`: 36 of 57, including both searches.

Checked and true in the same passes (not corrected): AGENTS.md 57 methods = 33 `content:read` + 22 `content:write` +
2 `audit:read`; the v3 catalogue has 25 tools; target19 is 19 tables / 228 fields
(`bun -e` over `KNOWLEDGE_METHODS`, `V3_CATALOGUE`, `TARGET_SCHEMA`); v3 acceptance
`bun test test/mcp-v3-acceptance.test.ts` prints `PASS 37 / FAIL 0 / GAP 0 of 37 steps` (39/0); `trace-v1.md` K-list
item 1's nine test files all carry `listTraces` (`rg -c listTraces` on each); every other AGENTS.md and README
citation opened by hand matched (`storage.ts:50-74`, `:217`, `pyproject.toml:17`, `composition.ts:33-34,66-80`,
`:84-87`, `registry.ts:271-282` (re-pin 2026-09-28: content shifted within the file), `auth/http.ts:15`, `:23-33`, `app/cli.ts:104-108` (re-pin 2026-09-28: shifted within `app/cli.ts`), `tools.isAdvertised.ts:14-18`,
`chat-model.types.ts:10-16`, `run_dev_server.py:45`, `search-chunk.profiles.ts:75-84`, `auth-integration.test.ts:97-107`,
`service.listSessionMembers.ts:39`, `service.getMessage.ts:18-26`, `taxonomy.constants.ts:44`, `app/cli.ts:192-199` (re-pin 2026-09-28: shifted within `app/cli.ts`)).

**Row statuses re-scored (AC-MATRIX.md §1-§2), on evidence run by this sweep:**

| Row | Was | Now | Evidence (run on `594df54`) |
|---|---|---|---|
| #27 AC3 horizon changes nothing | PARTIAL | PASS | `taxonomy-horizon-reassign-ac3.test.ts` 1/0 (69); `taxonomy-horizon-reassign-ac3-permissions.test.ts` 1/0 (147) |
| #28 TODO foreign visitors | PARTIAL | ~~PASS, with readings B/C as NEEDS-NAT (§4 item 11)~~ **PARTIAL, kept** (fix round: it is a NEEDS-NAT row, §4 items 6/11, and NEEDS-NAT rows stay as they are) | `relic-foreign-visitor.test.ts` 10/0 (24) |
| #28 AC1 (caveat) | PASS with caveat | PASS | `association-ac1-literal.test.ts` 1/0 (81) |
| #29 AC4 no decay, read-only reads | PARTIAL | PASS | `lifecycle-eligibility-ac4-schema.test.ts` 4/0 (6); `lifecycle-eligibility-ac4-readonly.test.ts` 1/0 (16) |
| #29 TODO self/cyclic supersede | PARTIAL | PASS | `lifecycle-supersede-self-cycle.test.ts` 1/0 (13); both cases are in one test, not two |
| #30 TODO partial coverage | PARTIAL | PASS | `search-chunk-retrieval-coverage.test.ts` 7/0 (101); `search-chunk-retrieval-candidate-ceiling.test.ts` 2/0 (49); `mcp-v3-search-wiring.test.ts` 24/0 (103); `mcp-v3-search.test.ts` 26/0 (304); `search-chunk-coverage-tie.test.ts` 1/0 (4); `cli-search.test.ts` 12/0 (34) |
| #31 audit across transports | PARTIAL | PARTIAL (the residual is now only the maintenance routes, NEEDS-NAT §4 item 10, draft PR #126) | `transport-audit-parity.test.ts` 2/0 (266); `transport-audit-refusals.test.ts` 2/0 (114); `transport-audit-legacy.test.ts` 3/0 (379). Each file's first test is a preflight |
| #75 independent re-certification | PARTIAL | PASS | `read-cursor-live-transport.test.ts` 2/0 (87; 1 preflight + 1 live test) |
| #75 row 1 root-level evidence | PARTIAL | PARTIAL (lint now evidenced; no CI verdict on HEAD) | ruff command above: `All checks passed!` |
| #85 acceptor re-certification | PARTIAL | PASS, with caveats: in-process route handlers, not TCP; largest case 7×51, not 9×51 | `chat-coverage.test.ts` 26/0 (6076); the Codex acceptor also re-ran it (row 38) |
| #34 tests/typecheck/lint row | PARTIAL | PARTIAL (lint now evidenced locally; CI blocked) | ruff command above |

Roll-up: 73/20/2/5 became ~~80 PASS / 13 PARTIAL~~ **79 PASS / 14 PARTIAL / 2 GAP / 5 SUPERSEDED** (100 rows; the fix round kept the #28 foreign-visitor row PARTIAL). NEEDS-NAT went from 12 to 13. Two
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
| GET `/api/memories` default 50; MCP `list_memories` default 20 | same | `rg -n 'limit' app/server/src/app.createApp.ts app/server/src/mcp/index.ts` | `app.createApp.ts:293-294`, `mcp/index.ts:183` (re-pin 2026-09-28: `app.ts` split into `app.createApp.ts`; `mcp/index.ts` shifted) |
| Overview subline "admitted MCP + HTTP calls · maintenance routes not logged" | same | `rg -n 'maintenance routes not logged' app/ui/v2/src/overview/OverviewView.tsx` | `:113` |
| one error-text function used by `runMcp`, the legacy routes and the kb audit | same | `rg -l auditErrorText app/server/src` | 4 files, as stated |
| FOREIGN-VISITOR §1-§2 citations: DESIGN.md:66-67, :91, :392, :415, :881, :1138; AGENTS.md:123; `relic.findSessions.ts:25`; `relic.rowToSessionRef.ts:29`; `evidence-v1.ts:51,:60-61`; `service.getContext.ts:55-68` (re-pin 2026-09-28: content shifted within the file); relic `cli.ts:59-61,:1306-1308` (unresolved: the external `relic` tool's own `cli.ts`, not `app/cli.ts` -- the drift checker's default resolution to `app/cli.ts` here is a false match, left as-is), `query.ts:1857` | FOREIGN-VISITOR.md; session-source-relic-v1.md | `sed -n <line>p <file>` for each | all true |
| `relic-foreign-visitor.test.ts` has 10 tests | same | `bun test test/relic-foreign-visitor.test.ts` | 10/0 (24) |
| mutant M2 (`bankFromRepo` keeps the whole `repo`) fails 2 tests, the `find` and `get` key-set tests | FOREIGN-VISITOR.md §3; session-source-relic-v1.md | replace `relic.bankFromRepo.ts`'s return with `return repo;`, run the file, then `git checkout --` the file | 8 pass / 2 fail, exactly those two tests; restored, then 10/0 and `git status` clean |
| `registry.ts:271-282` reads `listMcpCalls`/`listConnections` (re-pin 2026-09-28: was `:261-272`; content shifted within the file) | AGENTS.md:38 | `sed -n 269,283p app/server/src/knowledge/registry.ts` | true |
| `KNOWLEDGE_METHODS` at `registry.ts:157` has 57 entries | AC-MATRIX #31 | `bun -e` over `Object.keys(KNOWLEDGE_METHODS).length` | 57 |
| `mcp/tools.ts:29` "planned, not implemented" | AC-MATRIX #27, §4 item 5 | *(re-pin 2026-09-28: `b11ac98` "route legacy remember tool's type through taxonomy validation" rewrote this description -- it no longer says "planned, not implemented"; not re-verified here, left for AC-MATRIX #27's own owner)* | not re-checked |
| AC-EVIDENCE §1/§3 test-name citations: `createTrace.ts:195`, `relic-session-source.test.ts:119`, `contract-v1.test.ts:62`, `transport-ownership.test.ts:293`, `search-chunk-digest-boot.test.ts:244`, `target-schema-cross-language.test.ts:150`, `test_target_manifest.py:19`, `plan.py:98`, `taxonomy.requireLabel.ts:4-6` | AC-EVIDENCE.md | `sed -n <line>p` | all true |
| `trace-cycle-check.test.ts` 4/0, 14 expects | AC-EVIDENCE §1 | `bun test test/trace-cycle-check.test.ts` | 4/0 (14) |
| PLAN.md: #122 at 144 test files, #123 at 146, #124 at 154 | PLAN.md 16:54, 18:27, 18:58 | `git ls-tree -r --name-only <merge> app/server/test` plus `app/cli*.test.ts` | 144, 146, 154. The pass counts (2006, 2017, 2040) need the full suite, which this sweep may not run: **not re-checked** |
| PROOF.md §5: 36 tracked code files over 500 lines, all tests | PROOF.md §5 (measured on `d949290`) | `wc -l` over `git ls-files` code files, excluding the bundle | still 36, all tests, on `594df54` |
| `ui-e2e.test.ts` 9/0 | PLAN.md 15:51 | `cd app/server && bun test ../just/ui-e2e.test.ts` | 9/0 (46) |
| UI: `buildPublishInput.test.ts` 3 pass; `evidenceReview.test.ts` 22; `reflowText`+`a11yNames` 13 | UI-PROOF-ui-cite.md; UI-PROOF.md; UI-PROOF-ui-stale.md | `cd app/ui/v2 && bun test <file>` | 3, 22, 13 |

Batch re-runs of the AC-EVIDENCE commands are in §3.

**Not re-checked, and why.** Browser runs (`UI_E2E_RESULT`, screenshots, 812×375 measurements; the 21 count lines in
`UI-E2E.md`) need ego-browser on a shared machine. `DECISIONS.md:213` (`TestLiveRoundTrip` 1 OK) is a live Honcho run.
`lifecycle-v1.md:523-529` (VA harness PASS 10 -> 15 of 37) is a round-level record; today's harness is the v3
acceptance run above, 37/0/0. The other mutant counts (for example "M1 fails 4") need source edits. The sweep spot-checked one (M2, above), restored it, and committed no product change. Acceptor
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

- *Fix round, re-run on the fix-round tree (docs-only changes on top of `594df54`):* `run.sh <this worktree>
  proof-sweep-fix` exits **rc=2**, methods 57, HTTP 57 / MCP 57 / CLI 57, isolation **191 pass / 0 fail**, seed
  errors 0, fatal none, payload gaps 26 (the same probe-mode gaps as below). `run.sh <this worktree>
  proof-sweep-fix-issues --issues` exits **rc=2**, payload gaps 0, isolation 191/0, issue checks **146 PASS / 0 FAIL
  / 1 GAP** (#33 browser evidence, skipped by design). The six #85 rows (omission, truncation, control; HTTP and
  MCP) all PASS.

First pass:

- `bash .../live-probe/run.sh <this worktree> proof-sweep` exits **rc=2**. Methods 57, exposed HTTP 57 / MCP 57 /
  CLI 57, isolation **191 pass / 0 fail**, seed errors 0, fatal none, **payload gaps 26**. Every non-`--issues` run
  since 16:16 today reports the same 26 gaps ("no valid payload fixture"; for example `ac1-literal.md` and
  `chain-coverage.md`), so the 26 are the probe mode, not a regression.
- `... run.sh <this worktree> proof-sweep-issues --issues` exits **rc=2**. Payload gaps 0, isolation 191/0, and issue
  checks **146 PASS / 0 FAIL / 1 GAP**. The GAP is #33 browser evidence, skipped by design. Live #30 rows show
  `"coverage":"full","coverage_reason":null,"candidate_ceiling":4096` on HTTP and MCP answers.
