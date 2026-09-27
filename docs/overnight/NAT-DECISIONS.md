# Decisions only Nat can make: arra-oracle-v4 after 2026-09-27

Every item below is blocked on a ruling, a human-only input, or a billing action. Each lists
the options, the evidence, and the work each option would trigger. The source list is
`AC-MATRIX.md` §4 (items 1–11) plus today's findings. Everything *not* here is either done,
with the independent acceptor's verdict in `PROOF.md` §3c, or in progress.

Reply with the item number and your choice, for example "D3: b". Each ruling becomes an
R-number in `DECISIONS.md`, and any work it triggers goes through the same refuter loop.

## Quick table

| # | issue | decision | options | if you pick the work option |
|---|---|---|---|---|
| D1 | infra | GitHub Actions is blocked by billing | a) restore billing · b) accept the local `ci.yml` mirror as release evidence | a: nothing (CI resumes) · b: nothing (already used for #123–#128) |
| D2 | #29 #30 #85 #28 #33 | close issues the acceptor judged **DONE** | a) close now · b) wait | none |
| D3 | #32 / #31 | chat grounding scope | a) message-grounded chat is the target (redefine #32, strike "scoped representations" from #31) · b) peer representation plus node/revision-grounded context is still owed | b: M or more (observer/about-peer fields, `getRepresentation`, conclusions in context, token estimate and watermark) |
| D4 | #31 | where audit rows for instance-level `/api/backfill` and `/api/reindex` live (draft **#126**) | a) a reserved or nullable tenant (SPEC §6.3/§7.2 change) · b) a separate instance-level audit log · c) out of #31's scope, merge #126 as is | a/b: S–M, then #126's test flips |
| D5 | #27 / #31 | the legacy free-text `remember` tool bypasses taxonomy | a) validate it now · b) keep it as an unvalidated compatibility adapter until cutover | a: S |
| D6 | #10 | close basis | a) close on the target19 design (isolation 191/0, Thai retrieval proven) · b) hold until the active tables are migrated (a cutover, L) | b: blocked on D7 |
| D7 | #34 | production cutover | a) authorize it, and say when · b) re-scope #34 to "rehearsal proven" and track cutover separately | a: L, a supervised cutover |
| D8 | #34 | is R2 a deployment target? | a) yes · b) no, strike the R2 sub-item | a: M (restart, read-after-write, writer-exclusion test) |
| D9 | #28 | foreign-visitor strength | a) the pinned prohibition is enough · b) a `foreign_visitor` label (needs a non-cwd ownership signal Relic lacks) · c) lineage-only chain expansion (changes #32 chat) | b: M plus a signal source · c: S–M |
| D10 | #7 | relevance judgments | a) you supply the judgments (the harness is ready) · b) keep #7 release-excluded (R17) | a: run the harness on your judgments |
| D11 | #8 | table-level Honcho compatibility | a) accept **"FALSE as stated; TRUE WITH CONVERSIONS for one bank"** and correct SPEC §15.2 · b) invest in true byte compatibility (rename `h_metadata`, global message ids) | b: L, and it touches the schema |
| ~~D12~~ | ego lite | **RESOLVED 2026-09-27 without a restart.** Capture works again; the full `ui-e2e.sh` is green: `PASS ok=28 fail=0 skip=1`, with 13 fresh screenshots (`UI-E2E.md`) | — | — |

## Evidence behind each item

- **D1:** main's run 36310873591 on `cefc8db` never started, with the annotation *"recent account
  payments have failed or your spending limit needs to be increased"*. Since then every merge was
  gated by `.tmp/local-ci.sh`, which mirrors each `ci.yml` step. The results are in `PLAN.md`: 2006
  → 2066 server tests with 0 fail, UI 401 → 408, Python 269 → 271. A cheaper CI once billing
  returns: run `push:` only on `main`, because every PR now runs twice.
- **D2:** Codex TASK 10 (`PROOF.md` §3c) judged #29, #30, #85 and #28 DONE, and TASK 9 judged #33
  PASS per AC. Evidence comments are posted on each issue.
- **D3:** `AC-MATRIX.md` #32 has 6 PARTIAL, 2 GAP and 7 NEEDS-NAT. Chat today is grounded in
  messages only (R9).
- **D4:** draft PR #126. `mcp_calls.workspace_name` is a NOT NULL tenant key, and a sentinel row
  would be unreadable by any scoped reader and dropped by the #34 copy.
- **D5:** `app/server/src/mcp/tools.ts` (legacy `remember`).
- **D6/D7/D8:** `AC-MATRIX.md` #10 and #34 rows; R11 and R17.
- **D9:** `FOREIGN-VISITOR.md` §4, and the #28 comment posted 2026-09-27.
- **D10:** R16 and R17. The harness is under `app/benchmarks`.
- **D11:** `HONCHO-TABLE-DIFF.md` and the R15 table-level update. A verbatim INSERT fails on
  `h_metadata`, a second bank collides on `pk_messages`, and 10 v4-only columns are lost. The REST
  round trip passes (`app/just/honcho-live.sh`).
- **D12 (resolved):** a CDP `Page.startScreencast` probe was followed by working plain captures in a fresh space, and the
  full e2e then passed 28/0/1 with 13 fresh screenshots (`UI-E2E.md`, "Full green run").

*Written by v4-overnight (Claude Opus 5.5, AI), 2026-09-27.*
