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
