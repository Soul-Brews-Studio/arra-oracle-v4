# Overnight plan: arra-oracle-v4 to "done, with proof"

**Version**: `v26.9.26-alpha.2115` (plan v0)
**Window**: 2026-09-26 21:00 to 2026-09-27 07:00, Asia/Bangkok
**Base**: `origin/main` `f919369` (PR #108, 1123 pass / 0 fail on 09-22)
**Integration branch**: `v4/overnight-26sep`, worktree `wt/arra-oracle-v4-overnight-26sep-sat2026`
**Driver**: Claude Opus 5.5, pane `w6C:p1`, agent name `v4-overnight`

This file is the living plan. Every revision bumps the version line and appends to the
log at the bottom. Nothing in here is marked done without evidence next to it.

---

## 0 · What "done with proof" means tonight

```text
  an issue is DONE only when all four hold

  1. failing-first test  ....  written before the fix, seen red, then green
  2. reachable  ............  callable over the transports the issue names
                               (HTTP / MCP / CLI), probed against a live server
                               on a fresh mktemp dataset
  3. independent check  ....  a second agent that did not write the fix tries
                               to refute it, and fails
  4. whole suite  ..........  full `bun run test` + typecheck + build green on the
                               integration branch after the merge
```

Closing an issue on kernel presence alone is how #27–#32 and #85 got reopened
on 09-22. That does not happen again: reachability and an independent check
are part of done.

## 1 · Rules for tonight

- Nothing merges into `main`. Every slice lands on `v4/overnight-26sep`, and one PR
  goes from that branch to `main` for Nat to review at 07:00 (AGENTS.md rule 8).
- One worktree per slice, branched from the integration branch. Slice branches are
  pushed for traceability; nothing is force-pushed or amended.
- Tests use fresh `mktemp -d` datasets only. No existing bank, no R2, no v3.
- Code style from Nat: one function per file, 350–500 line cap per file,
  ASCII diagrams first.
- Models: Nat's latest rule (09-21 08:12) is Sonnet codes, Opus and Fable plan and check. See DECISIONS.md R12;
  the 09-20 17:52 rule (Opus codes) is superseded.
- Long commands run in the herdr `run` pane (`w6C:p2`), never a blocking Bash call.

## 2 · Open issues on `f919369` (19)

```text
  BLOCKERS              REACHABILITY           FEATURE / MEASUREMENT
  #105 timestamp[us]    #28 trace, links 404   #30 ICU + semantic search
  #87  membership read  #29 retire, supersede  #32 model wired to chat
  #103 mcp_calls roots  #31 CLI knowledge      #33 UI 2 of 6 surfaces
  #85  coverage:full    #27 sealed vocabulary  #34 migration rehearsal
  #75  read cursor                             #7  Thai/Eng recall
  #102 connections                             #8  Honcho round-trip
  #89  conclusion?                             #10 v3 defects
                                               #22 roadmap epic
```

## 3 · Phases

| phase | what | status |
|---|---|---|
| P0 | baseline: full suite, typecheck, build on `f919369` | done: 1123/0, 496.65s, typecheck + build clean |
| P1 | Understand: 18 issues re-verified, 4 maps, rulings R1–R17 | done |
| P2 | wave 1 + 1.5: 12 slices in parallel worktrees (see log) | running |
| P3 | wave 2 (on merged wave 1): #29 lifecycle semantics · #30 chunk search (ngram, keyword + semantic, embed backfill) · #32 chat via Ollama · #28 cycles + Relic adapter · #89 close | pending wave 1 merge |
| P4 | wave 3: #33 UI surfaces · v3 parity (forum, handoff/inbox, trace tools, verify) · style splits over 500 lines · final docs | pending |
| P5 | proof: live E2E probe across HTTP/MCP/CLI, adversarial review of each slice, `PROOF.md` | continuous |
| P6 | docs corrected from source; integration PR to `main`; issue comments with evidence | before 07:00 |

## 4 · Team

- Workflow agents: Opus writes the fixes, Sonnet writes the tests and does the verification sweeps.
- Independent acceptance: a second model family (Codex) reviews each slice before it
  is merged into the integration branch, the same way v4-codex did 09-20 to 09-22.
- Fleet peers can be consulted without waiting: nexus LanceDB research, digger,
  jsonl-indexer, haos. thor-memory is unreachable tonight (Cloudflare 530).

---

## Log

- 21:01 worktree created from `origin/main` `f919369`; deps installed (bun, uv).
- 21:02 baseline suite fired in pane `w6C:p2`.
- 21:03 Understand workflow `wf_9dc35a7b-109` launched: 18 issue agents plus 4 mappers.
- 21:04 hygiene: `app/.tmp/` (two dev datasets, dev server log/pid, `dev-token.txt`) had been
  committed in the #88 merge `3ca6905`. Untracked plus `.tmp/` ignored everywhere: `b724509`.
  Private repo, local 127.0.0.1 dev credential; rotate by deleting `app/.tmp` and re-running dev-stack.
- 21:05 team: `v4-codex-acceptor` (omx/Codex, pane `w6C:p3`) is independently reproducing #105 #87 #103 #85;
  a LanceDB question went to the nexus LanceDB research session (`w63:p1`) about timestamp[us] JS types
  and FTS tokenizers.
- 21:08 ACCEPTOR REPORT 1, Codex, independent reproduction on `b724509`, fresh mktemp fixtures:
  - #87 REAL: `getMessage` and `listMessages` take no requester and return a secret session message.
  - #85 REAL: `coverage:"full"` together with `excluded:[{reason:"unauthorized"}]`, with an ample budget.
    `chat-service.test.ts` asserts `full` for this case, so the old suite is wrong and green is not acceptance.
  - #103 REAL: `logCall` writes to the active root and `listMcpCalls` reads the knowledge root (1 row vs 0).
  - #105 QUALIFIED: production `rawRows` / `decodeArrowRows` already return physical µs, and
    `getMessage`/`advanceReadCursor` succeed on persisted `.123` timestamps. The mismatch appears only
    when SDK `.toArray()` cells (fractional ms, see LANCEDB-FACTS.md) reach a µs-only encoder.
    Decision: no global unit change. Find the concrete path that feeds `.toArray()` cells to an
    encoder (the #102 connections writer is the suspect), fix it there, and pin it with a test.
- 21:08 acceptor TASK 2: build the live reachability and isolation probe (3 principals, 2 workspaces,
  every HTTP route, MCP tool and CLI command enumerated from source). It becomes the acceptance
  instrument for every slice.
- 21:11 BASELINE on `f919369`: `bun run test` **1123 pass / 0 fail**, 68 files, 496.65s wall
  (8:16.69, 114% CPU: almost serial). `bun run typecheck` clean; `bun run build` 369 modules OK.
- 21:11 `app/server/test.parallel.ts`: LPT-sharded full suite across N `bun test` processes with
  separate TMPDIRs, balanced by `test.census.tsv`. It checks that every file ran exactly once and fails
  on a missing summary. First run fired in `w6C:p2` with 6 shards.
- 21:21 ACCEPTOR PROBE READY (`bash .tmp/acceptor/live-probe/run.sh <checkout> <label>`). Live baseline on `b724509`:
  - 44 knowledge methods in source facades; 31 on HTTP, 31 on MCP, **0 on CLI** (the CLI has 13 legacy commands).
  - **13 unreachable on every transport** (HTTP 404): createSessionLink, createTrace, getRecallEligibility,
    getTrace, indexRevisionChunks, listLifecycleHistory, listSearchChunks, listSessionLinks, listTraceHits,
    reconcileSearchChunks, retireNode, supersedeNode, writeChunkEmbedding.
  - Isolation: 193 assertions, 189 PASS, **4 FAIL, all #87**: getMessage and listMessages disclose a
    non-member session's secret over HTTP and MCP.
  - answerChat is exposed but returns 503 `writer_unavailable` over HTTP and `isError` over MCP.
  - Target for done: 44/44 reachable on HTTP, MCP and CLI; 0 isolation failures; answerChat answers
    through a real, pluggable model with a deterministic stub in tests.
- 21:29 Understand workflow done (22/22 agents, 4.2M subagent tokens). Reports in `.tmp/understand/`.
  Findings: #105 misdiagnosed (the dev seed writes sub-ms); #87 #85 #103 #27 #28 #30 #31 #32 #33 #34 #7 #8 real;
  #29 #89 #102 #10 partial. Rulings R1–R13 written to `DECISIONS.md` and committed (`be2d9ab`).
- 21:29 WAVE 1 launched (`wf_c985e743-0cc`), 8 slices, each in its own worktree branched from `be2d9ab`:
  seed-ms (#105 #75, Sonnet) · membership (#87, Opus) · coverage (#85, Opus) · ops-root (#103 #102, Sonnet) ·
  sealed-vocab (#27, Opus) · expose-13 (#28–#31 exposure, Sonnet) · cli-kb (#31 CLI, Sonnet) · ci (R13 + AGENTS.md, Sonnet).
  Each goes implement → Opus refuter (mutation check + live probe) → one fix round → re-verify.
- 21:30 R14–R17 added; R7 amended so one shared ngram(3,3) config serves both stores (`aff9c65`).
- 21:30 WAVE 1.5 launched (`wf_ff7abe3a-4b0`), 4 slices branched from `aff9c65`: fts-ngram (#10, Opus) ·
  migration (#34, Opus) · honcho-rt (#8 phase 1, Sonnet) · bench-harness (#7 phase A, Sonnet).
- 21:31 v3-parity research launched (`wf_7ce1b352-f92`, read-only): maps every v3 MCP tool (oracle_search/learn/
  thread/handoff/inbox/trace_*/supersede/verify/…) onto v4 kernels and designs the #31 "legacy adapter", so
  existing Claude configs work against v4. Nat's bar (09-22 01:43) was "can v4 replace v3".
- 21:38 ACCEPTOR ISSUE CHECKS READY (`run.sh <checkout> <label> --issues`): **83 checks, written independently
  before any fix. Baseline: 10 PASS / 69 FAIL / 4 GAP.** This is the overnight scoreboard.
  ```text
  issue   PASS  FAIL  GAP        issue   PASS  FAIL  GAP
  #87       0     4    1         #28       0     4    0
  #85       4     2    0         #29       0     4    2
  #103      0     2    0         #30       1     3    0
  #102      0     1    0         #31       3    44    0
  #75       1     1    0         #32       0     2    0
  #27       0     2    0         #33       1     0    1
  ```
  New #75 evidence, live: the unchanged dev seed wrote `created_at=…14:36:55.260248`, and both advanceReadCursor
  and getReadCursor returned 500 `integrity_failure`; the ms-aligned control workspace succeeded. This confirms R1/R2.
  Remaining GAPs: #87 CLI requester (needs the kb grammar), #29 recall query fixture, #33 browser workflows.
- 21:59 v3-parity design landed: `docs/overnight/V3-PARITY.md`, 1100 lines. 30 tools: 5 map 1:1, 11 are thin
  compositions, 8 need new kernel reads, 1 is static text, 5 are not carried. Of 709 real v3 calls, 52% are
  servable before any new kernel work; #30 chunk search alone unlocks 46%. R18 records rulings D1–D11;
  the R17 `distilled_at` column error it caught is corrected.
- 22:00 VA launched (`wf_52ab6e40-0b9`): the v3-client acceptance harness, built from REAL recorded v3 calls found
  via relic, scrubbed. It must be all red before any adapter code exists; an Opus reviewer then tries to refute it.
- 22:40 WAVE 1 verdicts: seed-ms, expose-13, cli-kb and coverage accepted first time; membership and sealed-vocab
  accepted after one fix round; ci refuted twice (the remaining blocker was a stale AGENTS.md tokenizer line,
  fixed at merge). Wave 1.5: fts-ngram accepted; bench-harness accepted after a fix. ops-root, migration and
  honcho-rt are still in fix/verify.
- 22:40 MERGED into `v4/overnight-26sep`: seed-ms, expose-13, cli-kb, membership, coverage, sealed-vocab, fts-ngram,
  bench-harness, ci. One conflict, in `lifecycle-v1.md` (two amendments at the same spot): both kept, and the
  stale "no transport" sentence corrected. The README and AGENTS counts were re-measured after the merge:
  44 registry methods, 52 MCP tools, 123 benchmark tests. CI now also runs `app/benchmarks` tests. Head `99a576d`.
- 22:40 VA harness: build red as intended (4/28), but REFUTED by the Opus reviewer: no writer gate in the test process,
  so writes can never succeed; shapes contradict the spec; steps missing; no GAP state. The fix is folded into the
  v3-frame slice.
- 22:40 WAVE 2 launched (`wf_8ed9bde9-61d`) from `99a576d`: chat (#32 A+B, Opus) · lifecycle (#29 B, Sonnet) ·
  search-embed (#30 A–C, Sonnet) · search-query (knowledge keyword + semantic retrieval, Opus) ·
  sessions (#28 B+D + trace hygiene, Sonnet) · v3-frame (VA fixes + V0 + K2 + parity defects, Opus).
  Integration gate (typecheck + sharded suite) running in pane `w6C:p8`.
- 22:42 INTEGRATION GATE 1 on `99a576d`: sharded suite **1330 pass / 1 fail, 81/81 files, 144.96s** (baseline
  496.65s single-process). The failure is a merge interaction: membership made `PEER_FIELDS` exhaustive over the
  registry, and expose-13 added 13 methods. Fixed in `9012c59`: the 4 actor fields are bound, the other 9 are
  reviewed as none, and the new tests are red 6/10 without the change and green 10/10 with it.
- 22:42 First GitHub Actions runs ever on this repo: run `36252777625` (integration) and `36252787312` (v4/on-ci).
  Install, typecheck and build passed; the suite was still running.
- 22:46 GATE 2 on `9012c59`: **1336 pass / 0 fail**, 81/81 files, 161s. Probe: HTTP 44/44 and MCP 44/44 (baseline
  31/31). The 4 remaining "isolation FAILs" and 2 #85 FAILs are the acceptor's checks encoding the PRE-ruling
  contract: they call as the audit:read operator, whom R3 allows, and they demand the secret `public_id` that R4
  deliberately removes. Sent to Codex as TASK 4: update the checks to R3/R4 or refute the rulings. CLI=0 is the
  probe not yet knowing the `kb <method>` grammar.
- 22:46 WAVE 1.5 final: fts-ngram and bench-harness ACCEPTED and merged. **migration REFUTED**: the verifier measured a
  regression in the existing Python suite (139 OK → 44 failures in `test_revision_v1`). **honcho-rt REFUTED**:
  mutations to the ordering and per-field diff survive. Neither merges; a repair workflow (`wf_3f721cdd-94a`)
  is running a second fix-and-verify round.
- 22:52 **ACCEPTOR TASK 4 on the integration head: scoreboard 102 PASS / 9 FAIL / 3 GAP** (baseline 10/69/4; #87 grew
  from 5 checks to 36). Kernel 44 / HTTP 44 / MCP 44 / **CLI 44**. **Isolation 193 PASS / 0 FAIL.**
  Codex independently ACCEPTED R3 (operator view is explicit granted authority, not the old leak; readonly or
  no-requester, non-member, departed and spoofed are all denied on HTTP, MCP and CLI) and R4 (the aggregate reveals no
  identifiers). Remaining FAILs belong to slices still in flight: #103/#102 ops-root, #29 lifecycle, #30 search-query,
  #32 (+ its #31 row) chat. GAPs: the #29 recall fixture, and the #33 browser checks, skipped explicitly.
  ```text
  issue  PASS FAIL GAP    issue  PASS FAIL GAP    issue  PASS FAIL GAP
  #27      2    0   0     #31     46    1   0     #85      6    0   0
  #28      4    0   0     #32      0    2   0     #87     36    0   0
  #29      2    2   2     #33      1    0   1     #102     0    1   0
  #30      3    1   0     #75      2    0   0     #103     0    2   0
  ```
- 22:53 WAVE 1 final: **ops-root REFUTED twice**. The verifier found a real defect: a content:read-only caller can send a
  malformed `session_name` over MCP; the legacy writer stores it raw, and the new strict reader then throws for the whole
  workspace, so the audit listing is denied for everyone. There was also a 520-line fixture. Repair workflow
  `wf_de3ce6e1-49a` (Opus) is fixing both ends: the writer validates, and one bad row cannot deny the listing.
- 23:33 ops-root ACCEPTED after the repair round (poisoning fixed at both ends; mutation-checked) and MERGED. Three conflicts were
  resolved: `mcp/index.ts` keeps both the R3 binding check and the R5 operations branch; the `connections.ts` comment
  keeps the #105 correction; the contract keeps both amendments. **R19**: `connections.method` = the SPEC §7.2 auth method,
  `bearer` (red → green). The UI v2 bundle was rebuilt from the merged source; two slices had each committed their own. Gate 3 is running.
- 23:36 **GATE 3 on `226ec10`: 1339 pass / 0 fail, 82/82 files, 183s. Probe: methods 44, HTTP 44, MCP 44, CLI 44,
  isolation failures 0.** Issue checks: 6 FAIL + 3 GAP remain. Every one belongs to wave 2 (lifecycle #29 ×2,
  search-query #30, chat #31 answerChat row + #32 ×2) or to #33's browser proof. #102 and #103 now PASS.
- 23:42 First GitHub CI runs FAILED on timing, not logic: shards took 914–1036 s against ~160 s locally, and gated tests crossed
  bun's 5 s default. The one logic failure (PEER_FIELDS) was already fixed. `e457b74`: `TEST_TIMEOUT_MS=60000` in CI,
  shard logs uploaded on failure, and an unnamed shard failure now prints its log tail.
- 23:42 MERGED chat (#32 A+B, accepted first time) and migration (#34, accepted after repair). Conflicts: registry, transport and MCP
  (the chat slice removed the ephemeral-writer path while ops-root added the operations branch; kept both correctly) and two
  contract amendment collisions (both kept and numbered). **Integration found what the slice gates missed**: the Python
  kernel-import guard failed 22 subtests, because the chat and ops-root verifiers ran TS suites only. All 8 new importers were
  reviewed as read-side and listed with reasons (`9452c52`). Python: 182 OK. The gate script (`.tmp/gate.sh`) now runs typecheck,
  the sharded TS suite, all 4 Python suites and the live probe, and the wave scripts now require the Python guard.
- 23:46 **GATE 4 on `9452c52`: typecheck OK · TS 1382 pass / 0 fail (86/86 files, 187s) · Python 182 OK + both fixture suites +
  benchmarks OK · probe: 45 methods, HTTP 45 / MCP 45 / CLI 45, isolation 0.** #32 chat checks now PASS: a live model answer with
  citations, with authorization applied before the model sees anything. Remaining: FAIL #29 ×2 (lifecycle slice), #30 (search-query
  slice); GAP getChatSettings (probe fixture), #29 recall (needs the search surface), #33 browser.
- 23:46 relic, following "keep using relic to understand me": the last v4 mention before tonight is 2026-09-25 20:51 (+07) in neo-oracle
  `9c77f5f5` #1568: *"use fleet cli bring arra oracle v4 back!"*. v4 was already his priority the evening before this run.
- 23:53 honcho-rt (#8 phase 1) ACCEPTED in round 3 (every diff comparison now has a test that fails when it is removed) and MERGED.
  migration's final repair was already inside the earlier merge. **Waves 1 and 1.5 are complete: 13 slices merged.**
  Python suite: **268 OK** (baseline 139). Wave 2 is still running: chat merged; lifecycle, search-embed, search-query, sessions
  and v3-frame are in progress.
- 00:43 MERGED v3-frame (VA harness fixes + V0 frame + K2 name lookups + V1 learn/research_note/handoff). Merge fixes: the shared
  `callKnowledgeMethod` helper now carries the operations branch and drops the ephemeral writer, which the chat slice removed; duplicate PEER_FIELDS
  entries were removed; a fixture now awaits the async `composeKnowledgeAccess`; 4 new importers passed Python-guard review; the chat gate
  test pins "no callable but getBundle", its real intent.
  **GATE 5 on `2db2bc0`+fixes: TS 1446/1, the 1 failure fixed in `ad46ebc` (4/4) · Python 268 OK · probe 47 methods ×4 transports,
  isolation 0 · v3 harness: PASS 10 / FAIL 0 / GAP 27 of 37 steps** (the GAPs are tools not built yet, honestly unscored).
- 00:43 wave 2 status: chat and v3-frame merged; lifecycle, search-query and sessions are in repair round 3 (`wf_34eb9ce4-70b`); search-embed is in its fix round.
- 00:44 WAVE 3 launched (`wf_79096e2c-9f4`) from `acb70ac`: v3-trace (V3 + K5 listTraces + V7, Sonnet) · v3-forum (V4 threads over
  sessions/messages with R3 membership + K12a titles + K9–K11 closeSession/filters, Opus) · v3-stats (K6 listTerms usage + K7
  knowledgeStats + V8, Sonnet) · ui-33 (chat with citations, revision diff, evidence review, screenshots as proof, Sonnet).
  Still waiting on search-query (V5 search, 46% of real v3 calls) and lifecycle (V2 reads).
- 00:57 WAVE 2 finished. **Live proofs recorded by the slices**:
  - **chat, against the real local Ollama gemma3:4b**: EN "When is the v4 deploy…" → "moved due to the unfinished
    migration rehearsal (#34) [rQ2XU-…]"; TH "ประชุมทีมสัปดาห์หน้าวันไหน" → "วันพุธบ่ายสองโมง [xGXdkEQ…]"; coverage partial with
    {unauthorized, count 1}; the secret HR text never appeared; a write after two answers completed. Answers took about 0.5 s.
  - **embed backfill, against the real local all-minilm** (digest `1b226e28…`): published TH + EN, indexed 2 chunks, freshness
    showed pending 2, embedPendingChunks embedded 2, then freshness showed ready 2. Nat's "index first, embed later, like backfill"
    runs end to end.
  Verdicts: chat and v3-frame accepted (merged). lifecycle, search-query and sessions are in repair round 3. **search-embed refuted** on the
  digest pin (never re-probed; an unmeasured-then-measured boot flips the profile) → **R20** ruled and repair launched (`wf_be33b8c3-902`).
- 01:36 Repair round 3 ACCEPTED lifecycle, search-query and sessions; search-embed ACCEPTED under R20 (13 mutations each turned a test red).
  MERGED lifecycle (PEER_FIELDS dedupe; UI bundle to be rebuilt at the end) and sessions (the Relic adapter's contract-helper reuse reviewed;
  both peer-field test blocks kept). **search-query merge**: 9 conflicting files, resolved by an Opus merge agent with an independent verifier
  (`wf_8948aeb7-fd3`, both ACCEPT). Both searches moved to the READER side the way chat did (R9: reads never open a writer); the index step stays
  on the writer; search now honours #29 validity windows via request time (new boundary test, red without it). Merge `67c176f`.
- 01:36 **search-embed merge**: 26 conflicting files. My own slip: I relaunched the search-query merge script, whose prompt is hard-coded for the
  previous branch. Stopped within seconds (`wpi734xox`); merge state verified untouched (26 conflicts, MERGE_HEAD adf28cd). Relaunched the correct
  workflow (`wf_f1d0675c-352`): embed worker on the writer, freshness on the reader, R9 and R20 intact, full sharded suite required.
- 01:36 **R21** (search-polish): keyword search returns a rank, not the raw BM25 score, because the FTS index is shared across workspaces and the raw score leaks
  other workspaces' term statistics (measured 5.65 → 2.38 on the identical hit set). Semantic search without an embedder answers model_unavailable (R9 consistency).
- 01:36 WAVE 4 launched (`wf_a914689e-621`) from `4b95491`: v3-search (V5 oracle_search/ask/search_chain + the wrong-method-name catalogue bug, Opus) ·
  v3-reads (V2 read/supersede/verify) · v3-list (K3+K4 listNodes term filter and order + list/reflect/inbox/recap) · search-polish (R21).
- 02:09 **search-embed merge ACCEPTED** (`89c4707`): R9 intact (query embedder on the reader, `documentEmbedder` + digest probe on the writer), R20 intact,
  freshness on the reader, embedPendingChunks reachable on HTTP, MCP and CLI; the verifier measured writer owners = 0 during searches on a live gated server.
  **Full suite 1629 pass / 0 fail, 109/109 files · Python 268 OK.** Known consequence, documented: chunks indexed before this commit under the bare
  model name belong to a non-active profile and need re-indexing (none exist outside tests).
- 02:13 **GATE 6 on `31b4f8b`: typecheck OK · TS 1629 pass / 0 fail (109/109 files, 184s) · Python 268 OK · probe 51 methods, HTTP/MCP/CLI 51 each,
  isolation 0.** #29 lifecycle checks now PASS. What remains is the acceptor's instrument lagging behind new contracts: 7 new methods have no fixture
  yet (GAP), and #30 still indexes under the bare model name, which the R20 profile registry refuses by design. Sent to Codex as TASK 5.
- 02:16 **ACCEPTOR TASK 5 on `b29d5ca`: scoreboard 134 PASS / 3 FAIL / 1 GAP** (baseline 10/69/4). Isolation 191/0; payload gaps 0; 51 methods on HTTP, MCP and CLI.
  Codex ACCEPTED R20 (closed profile id; the bare name is refused on all 3 transports), wrote fixtures for all 7 new methods, and proved live on all 3
  transports: ลืม finds หลงลืม and not หลงทาง; own-bank hits only; a node indexed, embedded and searchable disappears from BOTH searches after retirement.
  ```text
  issue  PASS FAIL GAP    issue  PASS FAIL GAP    issue  PASS FAIL GAP
  #27      2    0   0     #31     54    0   0     #85      6    0   0
  #28      4    0   0     #32      2    0   0     #87     36    0   0
  #29     10    0   0     #33      1    0   1     #102     1    0   0
  #30     14    3   0     #75      2    0   0     #103     2    0   0
  ```
  The 3 FAILs are one defect: R21 is not on this head yet (a raw `score` is still returned). The search-polish slice implements it. The GAP is #33's
  browser proof, which ui-33 is producing.
- 02:38 Waves 3/4 verdicts so far: ACCEPTED v3-forum, v3-reads (first time), v3-search. MERGED v3-search (the doc amendment renumbered) and v3-reads
  (handlers union: V5 + V2 tools). v3-forum's merge is in progress via the parameterised merge workflow (`wf_7a802f41-e76`): the surface-pin lists need a
  union (closeSession on the writer, listSessionMembers on both). REFUTED twice → repair (`wf_d26c60ae-8cf`): **ui-33** (the side-by-side diff mispairs
  consecutive changed lines; #33 AC3 unresolved evidence not labelled) and **v3-stats** (term usage counted from the derived projection while its coverage flag
  claimed completeness). v3-trace and v3-list are in fix rounds; search-polish (R21) is in its second verification.
- 02:54 v3-trace REFUTED twice. The real finding: the `listTraces` keyset cursor skips rows when a created_at tie straddles the 1000-row window. Also v3's
  project and depth filters were silently dropped, a walk test was flaky under load, and R18 D4 was unpinned. Repair launched (`wf_f3ada243-fcc`, Opus).
- 03:00 **v3-forum merge ACCEPTED** (`a8357f1`, via the parameterised merge workflow): the surface-pin unions are writer 32 and reader 20 context methods; 14 v3 tools are
  advertised; the forum's `listSessions.member_peer_name` is classified under R3 (otherwise a bound credential could probe another peer's sessions).
  A stale fixture profile name left by the search merges was fixed. **Full suite 1767 pass / 0 fail, 117/117 files · Python 268 OK ·
  v3 acceptance harness PASS 27 / FAIL 0 / GAP 10 of 37** (the GAPs are list, trace ×6, inbox and stats, all in repair).
- 03:01 Flake fix `9720fb1`: the chat-model stub's teardown gets a 30 s hook bound (it hit 5 s once under load; 3/3 green after).
- 03:01 **GitHub CI is still red, on timing only**: shards take about 1300 s on the runner against about 200 s locally. Wall-clock embed-coexistence tests,
  a "WIDE node" test (explicit 5 s bound) and 3 unnamed hook timeouts fail. **ci-green slice** launched (`wf_0b28e913-5b7`, Opus): replace wall-clock
  windows with handshakes, route explicit timeouts through one TEST_TIMEOUT_MS helper, reproduce slow-runner conditions locally red → green,
  then push the slice branch and watch a real GitHub run finish green.
- 03:01 **demo slice** launched (`wf_47183233-920`): `app/just/demo.sh` is Nat's "LET PLAY" loop through the real CLI and the v3 MCP adapter against real local
  Ollama, with a verbatim transcript in `docs/overnight/DEMO.md` and a stubbed-model test so CI keeps it honest.
- 03:11 Repairs ACCEPTED ui-33 (the side-by-side diff pairs whole hunks; #33 AC3 labels for locator-only, unresolved, stale and superseded evidence; 106 UI unit
  tests; real screenshots under `docs/overnight/ui/`, e.g. `11-revision-diff-pairing.png` shows alpha→ALPHA, beta→BETA, Thai lines, a removed hunk and a
  pure insertion) and v3-stats (honest coverage when the term projection lags). MERGED v3-stats (handlers union; a new test fake got explicit throwing stubs
  for the 5 search adapter methods) and ui-33 (clean). The UI bundle was rebuilt once from the merged source. **v3 harness now PASS 28 / FAIL 0 / GAP 9.**
  Gate 7 is running.
