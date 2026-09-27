# arra-oracle-v4 overnight: what is proven, and how to check it yourself

**Branch**: `v4/overnight-26sep` · **Base**: `origin/main` `f919369` · **Freeze**: `7d03bce`
**Window**: 2026-09-26 21:00 → 2026-09-27 07:00 (+07)
**Driver**: v4-overnight (Claude Opus 5.5, AI) · **Independent acceptor**: v4-codex-acceptor (Codex, AI)
**Also**: `PLAN.md` (timestamped log) · `DECISIONS.md` (rulings R1–R22) · `DEMO.md` (real run) ·
`V3-PARITY.md` (the v3 adapter design) · `ui/` (screenshots)

Every number here was measured on the branch, and the command that produced it is next to it.
Where something is partial or blocked, it says so.

---

## 1 · Scoreboard

```text
                                     main  f919369            this branch
  bun tests (all files)              1123 pass / 0 fail       2005 pass / 0 fail
  test files                         68                        143
  python  migrate-py discover        139 OK                    268 OK (1 skipped)
          fixture suites             (not run)                 17 + 22 OK
          app/benchmarks             (not in CI)               123 OK
  UI unit tests (app/ui/v2)          0                         106 pass / 0 fail
  knowledge methods (registry)       44                        57
    reachable HTTP / MCP / CLI       31 / 31 / 0               57 / 57 / 57
  isolation probes (acceptor)        189 pass / 4 FAIL         191 pass / 0 FAIL
  acceptor issue checks              10 PASS / 69 FAIL / 4 GAP 146 PASS / 0 FAIL / 1 GAP (freeze); 147/0/0 adjudicated after #121
  v3 client session, 37 real steps   —                         37 PASS / 0 FAIL / 0 GAP
  GitHub Actions CI                  no workflow               green on the freeze: run 36277285008 (2005/0, 143 files, Linux)
  "LET PLAY" demo, real Ollama       —                         25 STEP_OK / 0 FAIL (5 runs)
```

Reproduce:

```bash
cd app/server && bun run typecheck && TEST_SHARDS=6 bun test.parallel.ts
cd app/migrate-py && PYTHONPATH=src .venv/bin/python -m unittest discover -s tests
cd app/server && bun test test/mcp-v3-acceptance.test.ts          # v3 client session
bash app/just/demo.sh                                              # the whole loop, real Ollama
```

## 2 · How "done" was enforced

```text
 slice worktree ──► implementer: failing-first tests ─► fix ─► green
        │
        ▼
 independent Opus verifier tries to REFUTE
   · mutation check: revert the fix, the new tests must go red
   · live probe: real server, fresh mktemp dataset, 3 principals, 2 workspaces
   · review against the ruling, the style rules, and the Python architecture guard
        │ refuted ─► fix round ─► re-verify   (up to 3 rounds; every refutation is logged)
        ▼ accepted
 merge into v4/overnight-26sep ─► integration gate
   typecheck · sharded bun suite · 4 python suites · live probe --issues · v3 harness
        │
        ▼
 Codex acceptor (second model family) re-runs its OWN checks, written before any fix
```

Refutations did most of the work. Each row is a real defect caught before merge:

| slice | caught by the verifier or the gate |
|---|---|
| ops-root | a `content:read` caller could permanently deny the audit listing with one malformed session name |
| migration | a regression in the existing Python suite (139 OK → 44 failures) |
| search-embed | a model upgraded under the same name would have mixed vectors silently (→ R20) |
| search-query | the Thai substring re-check had no test that failed without it |
| v3-trace | the `listTraces` cursor lost rows when a timestamp tie straddled the scan window |
| v3-list | recall tools returned nodes the eligibility check calls ineligible |
| honcho-rt | per-field diff checks could be deleted with every test still green |
| ui-33 | the side-by-side diff mis-paired consecutive changed lines |
| integration | the kernel-import guard failed after merges whose verifiers ran TS tests only |
| integration | R21's tests were green on their slice and red once merged (a stale profile name, and an adapter bug) |
| CI | Linux refuses a single argv string over 128 KiB (E2BIG); macOS does not |
| R21 → R22 | removing the score was not enough; another workspace could still reorder hits |

## 3 · Issue by issue

`A` = acceptor check rows (Codex, independent, written before the fixes).

| # | title (short) | status | ruling | proof |
|---|---|---|---|---|
| 105 | storedTimestamp rejects timestamp[us] | **resolved** (misdiagnosed) | R1 | the store holds true µs; the dev seed wrote sub-ms values and is fixed; validators refuse JS numbers; `timestamp-unit.test.ts`; LANCEDB-FACTS.md |
| 75 | read-cursor integrate | **done** | R2 | live: advance→get 200/200/200 on the fixed seed, 500 on the old one (`live-r2/run.sh`); A 2/0 |
| 87 | membership read boundary | **done** | R3 | Codex accepted R3 after attacking it; A 36/0; isolation 0 FAIL |
| 85 | coverage "full" over an exclusion | **done** | R4 | Codex accepted R4; A 6/0; the unauthorized aggregate reveals no identifiers |
| 103 | mcp_calls in two roots | **done** | R5 | A 2/0; a poisoning defect found and fixed during review |
| 102 | connections writer | **done** | R5, R19 | A 1/0; `method = bearer` per SPEC §7.2 |
| 27 | sealed vocabulary | **done** | R6 | A 2/0; refused on HTTP, MCP and CLI |
| 28 | traces, session chains, Relic evidence | **done** (dereference deferred by ruling) | R7 | A 4/0; cycle rule over both relations; Relic adapter behind an interface; K5 listTraces with a tie-safe cursor |
| 29 | lifecycle | **done** | R7 | A 10/0; default-exclude, `--history`, validity window at request time |
| 30 | search chunks, embeddings | **done** | R7, R14, R20, R21, R22 | A (see §1); live real-Ollama embed; Thai ลืม ⊂ หลงลืม; digest pin; rank only; workspace-local order |
| 31 | one service on HTTP, MCP, CLI + legacy adapters | **done** | R8, R18 | 57/57/57; v3 client session 37/37 |
| 32 | peer chat | **done** | R9 | live gemma3:4b answers in EN and TH with citations; secrets never reach the model |
| 33 | UI | **done** | R12 | chat, revision diff, evidence review, AC3 labels; 106 UI tests; screenshots in `ui/` |
| 89 | conclusion-shaped table | **decided** | R10 | `conclusion` is a reserved type term, not a table |
| 34 | migration rehearsal | **partial** | R11, R17 | the rehearsal runs on a copy, the source is untouched, conservation holds; its release gates depend on #7 and #8 and are named, not faked |
| 10 | v3 defects | **partial** | R14 | Thai inside-word search and supersede_log peer checks are fixed; the active-15 tenant columns remain |
| 7 | Thai/Eng recall measurement | **blocked on you** | R16 | the harness is done; the judgments must come from a human, as the issue itself requires |
| 8 | Honcho round-trip | **live leg PASS** (REST level) | R15 | phase 1 is done against a fixture; **2026-09-27: the live leg ran against a disposable pinned Honcho v3.2.0** (`app/just/honcho-live.sh`): `TestLiveRoundTrip` OK, 0 problems, torn down. Not proven: byte-level table compatibility |
| 22 | epic | open | — | tracks the above |

## 3b · The independent acceptor's final verdict (Codex, verbatim in substance)

Final live run on the freeze: **146 PASS / 0 FAIL / 1 GAP**, isolation 191/0, methods
57 × HTTP/MCP/CLI, payload gaps 0. R22 is PASS on all three transports: ALPHA's bytes and
hit order were identical after 36 BETA-only mutations. No new application defect was found.

| acceptor classification | issues |
|---|---|
| **accepted as done** against the ruled contracts | #87, #102, #103 |
| **measured repair passes**, but not every frozen fault/ownership gate was certified by this run | #75, #85 |
| **partial at whole-issue level**: every selected live check passes, but a bounded probe does not prove every historical acceptance criterion | #27, #28, #29, #30, #31, #32 |
| **partial**: its probe did not run a real browser (the fresh build and served assets pass). The driver's ego-browser screenshots are in `ui/` | #33 |

> "This is a green bounded backend acceptance, not blanket production-ready or
> all-issues-closed certification."

Where this verdict is stricter than the status column in §3, **the acceptor's verdict
wins**. The PR therefore says `Fixes` only for #87, #102, #103, #105 (misdiagnosed and
resolved) and #89 (decided). It says `Refs` for everything else, and Nat closes those.

## 3c · After the merge: #110–#118 and the acceptor's re-runs (2026-09-27)

Nine more PRs merged into `main` after #109 (#110–#118). Each one went through the same loop:
implement, independent Opus refuter (mutation check plus a live ego-browser run), fix, re-verify.
Each merged only once accepted. `PLAN.md` "after the merge" has the timestamped log.

| PR | what | rounds to accept |
|---|---|---|
| #110 | UI search box: keyword and semantic, rank only, Thai inside-word | 2 |
| #111 | CI concurrency: superseded runs cancel; `main` never does | — |
| #112 | the 500-line cap enforced by tests; `revision_v1.py`, `rehearsal.py`, `catalogue.ts` split | 2 |
| #113 | UI cite, correct and lifecycle lock (the UI used to hardcode `link_snapshot_json: "[]"`); CI runs UI tsc, UI tests and a stale-bundle check | 1 |
| #114 | search query in the route; Back/Forward sync; wiring pinned by mutants | 4 |
| #115 | refusals surface; a correction needs a `corrects` link; the publish call site pinned | 3 |
| #116 | layouts usable at 320–1440px (inner-scroller scan clean); accessible names; honest 401/403 | 7 |
| #117 | `app/just/ui-e2e.sh`, a checked-in browser test of the #33 chain (14 DOM steps) | 2 |
| #118 | key-guarded reads: no stale node or session content after navigation or writes | 3 |

**Codex TASK 7** (`b3fa70d`): 146 PASS / 0 FAIL / 1 GAP, isolation 191/0, no regressions.

**Codex TASK 8** (`d949290`, after #118): the backend is unchanged at **146 PASS / 0 FAIL / 1 GAP**,
isolation **191/0**, methods 57 × HTTP/MCP/CLI, payload gaps 0. Its independent browser run of
`ui-e2e.sh`: **all 14 DOM steps pass**, including real local-Ollama chat. The 13 failures are all
`Page.captureScreenshot` timeouts in ego lite on this machine. Its #33 judgement, per AC:

| #33 AC | Codex | what is still missing |
|---|---|---|
| AC1 create → revise → cite → correct → supersede → history, peer-context chat | **PASS** | — |
| AC2 Thai/English, long titles/paths, keyboard, narrow layouts | **PARTIAL** | native keyboard proof (the harness uses DOM events, not keys); tab roles and roving focus; the 812×375 landscape floor |
| AC3 historic labels/body unchanged; stale/unavailable labelled | **PASS** | the dangling-target case stays SKIP: the server refuses to create one |
| AC4 screenshots and browser evidence | **PASS**, with a capture GAP | fresh screenshots: capture currently times out |
| revision-2: freshness, provenance, distinct author/observer/subject, missing summary visible | **PARTIAL** | the node header lacks the roles; there is no freshness or missing-summary UI |

It also noted that #118 guards reads tied to a selection, not every async action: the `ask` result
is not keyed yet. Wave 8 (keyboard, provenance/freshness, keyed actions) targets exactly these.

**Codex TASK 9** (`2d5ef44`, after #120 and #121): **#33 PASS against every requested AC.** The raw probe
is unchanged at 146 PASS / 0 FAIL / 1 GAP, because the backend probe deliberately runs no browser. With
the separate browser evidence, the adjudicated roll-up is **147 PASS / 0 FAIL / 0 GAP**. Isolation is 191/0,
methods 57 × HTTP/MCP/CLI, and there were no regressions.

| #33 AC | Codex TASK 9 |
|---|---|
| AC1 chain + chat | **PASS**: it repeated the chain by keyboard (`ui-e2e-keys.sh` 15/15); TASK 8 covered real-Ollama chat |
| AC2 Thai/English, long paths, keyboard, narrow layouts | **PASS**: keyboard input only (it read `keys.mjs`/`keyNav.mjs`); 812×375 measured independently |
| AC3 historic immutability, stale/unavailable labels | **PASS**: the dangling-target write stays honestly not exercised |
| AC4 screenshots and evidence | **PASS** for the delivery evidence; fresh capture remains an environment gap |
| revision-2: freshness, provenance, author/observer/subject, missing summary | **PASS**: reproduced on its own stack, including a pending → indexed transition |

The `ask` residual is closed. In Codex's words, this is "not a full WCAG audit, model-quality
certification, or blanket whole-roadmap completion."

**Codex TASK 10** (`5e890fe`, after #122–#127). The raw probe is unchanged at 146/0/1: the GAP is the
browser bucket, which is not run by design. Isolation is 191/0, and all 57 methods are on HTTP/MCP/CLI.
The acceptor checked the new claims in scenarios it wrote itself:
- HTTP audit rows and body-scope refusal parity: **PASS**.
- Saturated search reports `coverage: "partial"`, and `oracle_search` warns: **PASS**.
- Legacy `/api/memories` rows have the same audit shape as MCP `remember`: **PASS**.

It re-ran five sampled AC-MATRIX PASS rows, and none was falsified. The evidence total is 269 targeted
tests with 0 fail. Its per-issue verdict:

| verdict | issues |
|---|---|
| **DONE** against the reviewed ACs | #29; #30 (not an unbounded-recall or quality guarantee); #85; #28 (prohibition reading) |
| target ACs done, closing blocked on a Nat ruling | #27 (legacy `remember` taxonomy) |
| partial, or waiting on Nat | #31 (scoped representations; `/api/backfill` and `/api/reindex` audit is draft #126); #32 (message-only chat); #10; #34 (cutover, R2, local-mirror evidence) |
| partial only at the strict release-proof level | #75: 83 frozen tests pass and the live replay passes; it needs the local CI mirror accepted, or Actions restored |
| carried forward | #33 (the TASK 9 PASS); #7 (relevance judgments); #22 (the epic) |

## 4 · Live proofs on m5 (real services, fresh datasets)

- **Chat via the real local Ollama gemma3:4b** (`DEMO.md` step 15). The Thai question got
  "คุณต้องทำการ snapshot ดิสก์ก่อนซ้อมย้ายข้อมูลทุกครั้ง [rbfyvYtW8I6urzvR72599]", with coverage `full`.
  The chat slice's own run gave `partial` + `{unauthorized, count 1}` when a secret was linked, and the secret
  never appeared.
- **Embedding backfill via the real all-minilm.** Freshness went pending 2 → ready 2, and the digest was
  pinned (R20).
- **Thai inside-word search.** `ลืม` finds "อย่าหลงลืม snapshot…", and `หลงทาง` does not match
  (HTTP, MCP and CLI).
- **v3 client.** `oracle_learn` → `oracle_search` → `oracle_thread` → `oracle_thread_read` over raw MCP
  (`DEMO.md` steps 19–23), plus the 37-step recorded session.
- **UI.** `ui/11-revision-diff-pairing.png` and the others, from a real server.

## 5 · Honest limits

- **Search, R22 residual.** Order is workspace-local, but when a workspace has more matches than the
  4096-candidate overfetch, *which* candidates enter can still depend on global statistics.
  A per-workspace index closes it (`search-chunk-v1.md` §20).
- **Style debt.** Since #112, **no source file is over 500 lines**, and tests enforce the cap
  (`test_file_size_cap.py`, `file-size-cap.test.ts`). Measured on `d949290`: 36 tracked code files
  are over 500 lines, and all 36 are tests. Some files still export more than one function
  (disclosed per PR).
- **Needs you.**
  - #7 relevance judgments.
  - #8: the live leg now passes at REST level (2026-09-27). Whether that is enough to close the issue, given the historical "byte-compatible" wording, is your call.
  - Chat providers other than local Ollama.
  - Everything in `DECISIONS.md` you want to overturn.
- **Screenshots (resolved 2026-09-27).** `Page.captureScreenshot` timed out in ego lite on m5 for most of the day.
  It works again without a restart, and the full `app/just/ui-e2e.sh` is now green: `PASS ok=28 fail=0 skip=1`,
  with 13 fresh screenshots (`UI-E2E.md`, "Full green run"). The e2e still runs locally only; ego lite is not in CI.
- **Merged.** #109 went into `main` on Nat's "merge all pr", and #110–#118 followed, each once accepted.
