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
  bun tests (all files)              1123 pass / 0 fail       FINAL_TS
  test files                         68                        FINAL_FILES
  python  migrate-py discover        139 OK                    268 OK (1 skipped)
          fixture suites             (not run)                 17 + 22 OK
          app/benchmarks             (not in CI)               123 OK
  UI unit tests (app/ui/v2)          0                         106 pass / 0 fail
  knowledge methods (registry)       44                        57
    reachable HTTP / MCP / CLI       31 / 31 / 0               57 / 57 / 57
  isolation probes (acceptor)        189 pass / 4 FAIL         FINAL_ISO
  acceptor issue checks              10 PASS / 69 FAIL / 4 GAP FINAL_ACC
  v3 client session, 37 real steps   —                         37 PASS / 0 FAIL / 0 GAP
  GitHub Actions CI                  no workflow               green: runs 36275352354, FINAL_CI
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
| 8 | Honcho round-trip | **partial / blocked** | R15 | phase 1 is done against a fixture; the live run needs a container runtime |
| 22 | epic | open | — | tracks the above |

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
- **Style debt.** 40 tracked files are over 500 lines, and 38 of them were already over at `f919369`.
  Two legacy Python modules are over the cap (`revision_v1.py` 773, `rehearsal.py` 592). 12 of 561
  src files export more than one function.
- **Needs you.**
  - #7 relevance judgments.
  - #8 needs a container runtime.
  - Chat providers other than local Ollama.
  - Everything in `DECISIONS.md` you want to overturn.
- **Not merged to `main`.** That is your call, via the PR.
