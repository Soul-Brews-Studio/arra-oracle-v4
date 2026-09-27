# Delivery gates after the isolated source-contract slice

Evidence snapshot: 2026-09-20, local commit `11cf7235a815234d305f338982cf2cf53ef21197`. This ledger updates delivery status, not the logical schema or an authorization policy. No runtime activation is implied.

## Three distinct states

```text
RUNNING SPIKE (NOT RESTARTED)  ACCEPTED LOCAL SOURCE             REMAINING PRODUCT WORK
15 tables /152 fields         target19 /228 isolated fields      serialized writer
8 memory-spike tools          canonical bytes/source mappings   publication + ingestion
no new auth activation        auth for existing transports      target-service access
local-only deployment         scratch fixtures/client gates     taxonomy/search/context/UI
```

These columns are distinct states, not an executed migration. Target19 and revision/source persistence services remain isolated. Local authorization integration now uses the pure policy and strict parsing helpers for the existing transports; that does not activate target tables or restart the running spike. The 19-table change is 15 - memories - memory_terms + six target tables, not 15 + four additions.

## Evidence and responsibility ledger

| Requirement | Current evidence / status | Remaining enforcement or delivery owner |
|---|---|---|
| Target physical schema, types/nullability/vector dimensions | Accepted `8618094`; 19 tables/228 fields; static golden and persisted drift fixtures | Defined by #23; remaining copy-migration proof: #34 |
| Revision/evidence bytes, typed target identities, source/revision replay classification | Accepted isolated package `6289311`; fixed vectors, real Python/Bun and persisted round trips | Defined by #23; remaining service use and accepted-operation semantics: #26/#28 |
| New opaque IDs, Int64 wire strings, exact UTC millisecond strings | Existing v1 codecs; target model shape and raw-microsecond fixture checks | Accepted pure boundary mapping at `33e3c44`; #34 conversion/rejection rehearsal |
| Source columns and source-vs-ingestion time | Accepted pure source/legacy boundary package `33e3c44`; namespace injection, all-or-none predicate, time mapping and destination-aware replay | #23 contract definition is satisfied; no durable ingestion or uniqueness follows from pure mapping. #31 owns shared runtime transport error consistency; #28 ingestion validates scope, resolves replay and allocates sequence under serialization |
| Exactly one type, zero/one horizon; allowed terms and same-workspace references | DESIGN sections 7-8 define rules; physical models and immutable snapshots do not enforce them | #27 service validators; #26 validates complete revision before publication; #25 authorizes |
| Evidence truth and direct/reverse traversal | Canonical target keys proved; capture truth, permissions and query results not proved by hashes | #28 verifies pinned-source handling and equality of direct/reverse queries; #25 access |
| Principal vs peer/author/observer/subject | Separate audit principal/credential/policy attribution accepted at `11cf723`; domain peer fields unchanged | #28 target-content propagation; #34 legacy unknown-attribution preservation |
| Current MCP scope, logs, redaction, rejected extra route | Accepted store-boundary repair `7dd21d0`; required scope precedes storage/model access. #24 closed with targeted and two-bank evidence | #24 closes measured spike gates only; no authentication claim |
| Authorization / token expiry, revocation, grants | Isolated policy `eb281cc` and local existing-transport integration `11cf723` accepted; no running-service restart | #25 remains open for target sessions/traces/evidence/configuration and cross-reference coverage; deployment separately gated |
| Revision publication, retries, stale-base conflicts, recovery, writer exclusion | Byte validators/classifiers are prerequisites only | #26 fault-injected persistence protocol and process-level ownership |
| Supersession and retirement | Physical contract, flat lifecycle design; no target service proof | #29 expected-revision/authorization/append-only event behavior |
| Revision-aware embedding/search reconciliation | Current spike embedding exists; target chunks shape does not ship revision-aware search | #30 save-first projections, profile binding and reconciliation; #7/#10 Thai recall/legacy defect measurements |
| Shared HTTP/MCP/CLI methods | Local source routes existing eight tools and HTTP/CLI/browser calls through admission at `11cf723`; new codecs are not tools | #31 target methods and explicit legacy adapters; #25 authorization must extend with them |
| Context, representation and peer/session chat | Design only for target service | #32 bounded permitted context, evidence, explicit-save actions; reusable scopes may be validated config, not another table |
| Knowledge Explorer/revision diff/evidence UI | Target UI not proven by backend fixtures | #33 browser-level acceptance |
| Honcho interoperability | Historical SPEC section15 is an unproved tier-1 claim; no revision hash coupling | #8 real target deployment identity + export/import test, no reliance on dead endpoint |
| Copy migration and release | No live activation/migration authorized | #34 non-destructive rehearsal, compatibility and deployment checks |
| Serena / CodeGraph | Native MCP bridge calls succeed; refreshed source index | #37 tooling evidence; neither call-graph counts nor connectivity proves product behavior |

## Next gates, without changing scope

1. Preserve #24 accepted scope enforcement and fixture-limited redaction wording; it is not authentication.
2. Record #23 final contract acceptance using the physical, byte and source commits. Downstream enforcement remains assigned in the ledger above; closing a contract gate does not complete those services.
3. Preserve accepted #25 existing-transport admission and review #26 persistence before implementing durable target services. Extend #25 coverage with each new target service; neither RFC8785 nor a single-writer comment supplies those guarantees.
4. Deliver #27-#34 through bounded slices against the shared service, rather than creating independent MCP-only behavior.

#23 contract-definition gates are satisfied by the reviewed physical, byte and source contracts. Tracker closure is recorded separately after this status reconciliation; no runtime completion follows. Every later issue remains independently subject to its acceptance criteria. PR #1 is historical and unchanged; replacement/merge decisions are separate from local acceptance.

## Latest verification scope

At `11cf723`: root independently ran 82 Python tests and 347 Bun tests /2188 assertions, strict TypeScript, build, changed-Python Ruff and tracked/untracked whitespace checks; the frozen files remained byte-stable. Eight independent route probes returned the expected rejection with zero storage effects. The exact 20 committed paths, parent and blob hashes matched that acceptance snapshot. The implementer reran the same suites on the committed tree. Whole-tree lint is not claimed clean. No push, restart, real credential provisioning or live dataset/R2 write occurred.

Limits: header checks reject the measured post-flattening grammar, not raw line counts; enumerated source-text scans are not import resolution; secret-bearing fixture redaction is not universal secret detection. The shared facade covers existing operations, not future target-service references. #25 remains open.

Earlier source-contract evidence at `33e3c44`: accepted stable-tree Python discovery 79 tests; Bun full app/CLI suite 168 tests /1520 assertions; strict TypeScript, build and whitespace checks passed. Root independently verified the four committed blobs, exact changed-file set and parent against captured acceptance evidence, and ran 61 independent source-boundary assertions before commit. Whole-tree lint is not claimed clean. No push, release, production authorization or service-invariant proof is claimed.

See [source acceptance](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/23#issuecomment-5749867140) and [scope closure](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/24#issuecomment-5749732127). Earlier physical/byte evidence remains in #23; this ledger does not replace it.

## Amendment 2026-09-26 (overnight R11 + R17)

Appended; the table row "Copy migration and release" above is left as recorded. Rulings: [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) R11 and R17.

**What changed.** #34 has a non-destructive rehearsal: `arra-migrate-copy` (Python orchestrator, `app/migrate-py/src/arra_migrate/copy_migration/`) plus the Bun knowledge worker (`app/server/src/migration/`). Evidence lives in `app/migrate-py/tests/test_copy_migration.py` and `app/server/test/migration-copy.test.ts` (`bun run test:migration`). The latter runs the real server on the legacy source before and after the migration: legacy MCP recall answers identically (the rollback leg: the source is never replaced), and a server mounting the candidate serves the migrated nodes through `listNodes` / `getAcceptedHead`.

**Still excluded, on every report.** `release_exclusions` names #7 (relevance judgments), #8 (stock Honcho container round-trip) and #10's quality half, and `release_ready` is always `false`. R2 is out of scope: `://` roots are refused. No cutover is implied; the source remains the served dataset.

**Fix round, same night.** Appended. More evidence for the "Copy migration and release" row:

- **Rollback leg.** It compares the FULL legacy MCP responses (`recall` for three queries, `get_memory`, `list_memories`) as JSON, not only sorted ids. It now also restarts the server on the source ALONE after the candidate was mounted.
- **Projection rebuild.** In a copy of the candidate, `node_revision_terms` and `revision_links` are emptied, and the kernel's `reconcileRevisionAssociations` rebuilds them to identical rows.
- **Crash.** A deterministic SIGKILL mid-knowledge-phase, at the kernel's `after_revision_append` boundary on the third publish, leaves no table in the candidate, and a rerun converges.

Still NOT covered on this slice, so #34 is not closable on it:

- the rev-2 release-audit items;
- a browser check;
- a standalone release-audit document.

The #7/#8/#10 exclusions are carried in every `report.json` and in this amendment.

## Amendment 2026-09-26 (overnight R13 (CI must actually pass))

Appended; the ledger and verification scope above are left as recorded. Ruling: [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) R13.

**What changed.** GitHub Actions CI (`.github/workflows/ci.yml`) had never passed on
`v4/overnight-26sep`. The shard failures were read from the runs' shard logs, and most were not
timing:

- **E2BIG, three suites.** Linux refuses any single argv/env string over 131071 bytes; macOS does
  not. `mcp-v3-writes` (312355 bytes; its `beforeAll` threw, reported as "(unnamed)"),
  `session-link-service`'s WIDE node (250968) and `list-pagination-isolation` (146307; an error
  "between tests") passed locally and died at `posix_spawn`. `runGated`/`spawnGatedChild` now
  spill arguments over 64 KiB to a file the child reads with `readArgPayload`, and
  `runOwnedChild` refuses an oversized string on every platform.
- **A wall-clock ordering bound.** `search-chunk-embed-worker` asserted a publish took under
  250 ms; the runner measured 260-351 ms with nothing wrong. It is now proven by settle order and
  a held embedder (search-chunk-v1 §19), and the M4 mutation is still caught.
- **A teardown hang.** The chat model stub's `stop()` waited on a handler that never settles; on
  Bun 1.3.14 `server.stop(true)` then resolves only if something else wakes the event loop. It
  hit the 30 s hook bound on the runner and reproduced locally. The stub now settles what it holds.
- **A platform-specific exclusion.** `mcp-v3-writes` excluded Bun's transpiler cache only at its
  macOS path; on Linux it lands in `HOME/.bun/install/cache/@t@`. The child now runs with the
  cache off and the test asserts its HOME is empty.

Harness: every explicit test/hook timeout goes through `testTimeout` and every child deadline,
injected timeout and "never a hang" bound through `scaledMs` (identity locally; CI sets
`TEST_TIME_SCALE=5` and `TEST_TIMEOUT_MS=60000`). `test.parallel.ts` names the file behind an
unnamed failure, reports cores and CPU utilisation, streams shard logs to disk, and accepts
`TEST_GROUPS`/`TEST_GROUP` for a matrix, which is not used: the runner has 2 cores that 4 shards
keep 90% busy, so more shards cannot help and more machines would cost more minutes.

**Evidence.**

- Red, on the base `9720fb1` (run 36268048901): 1661 pass / 5 fail (plus a list-pagination file that
  never registered its tests). Before that, runs 36260049043,
  36265042727 and 36265462602 failed the same way.
- After the E2BIG, embed and harness changes (run 36269825188, `37484e9`): 1777 pass / 1 fail, the
  one being the Linux transpiler-cache path, fixed next.
- Green (run [36271049858](https://github.com/Soul-Brews-Studio/arra-oracle-v4/actions/runs/36271049858),
  `f7aafb0`): 1780 pass / 0 fail across 120/120 files, Python 268 (1 skipped) + 17 + 22 + 123 OK,
  UI build OK. The job took 24 min 39 s of its 25 min cap on a slower runner, so `timeout-minutes`
  is now 40.
- Locally, before and after each fix: the failing-first tests were red for the measured reason (a
  316221-byte argv string reached a child; `publishResult.elapsedMs` 322-727 ms under CPU
  contention; `stop()` hung past 10 s; the three `.pile` files in the child's HOME) and green after.

## Amendment 2026-09-26 (post-merge #33 AC2 (keyboard navigation, narrow layouts) + R12)

**Change.** The #33 browser-level acceptance row now includes a keyboard-only proof. The UI's
tab strips (the app view tabs and Explore's detail tabs) follow the WAI-ARIA tabs pattern:
`role=tablist/tab/tabpanel`, `aria-selected`, `aria-controls`/`aria-labelledby`, a roving
tabindex, ArrowLeft/ArrowRight/Home/End move focus, and Enter/Space activate (manual activation,
the same everywhere). The peer, session and node list rows are native buttons in the Tab order.
They carry `aria-current` when selected, and ArrowUp/ArrowDown/Home/End also move between rows.
Opening a node from outside `<main>` moves focus to its heading. A `short` screen (max-height
500px, below `lg`) unpins the app shell, so at 812x375 the Explore detail pane and the messages
pane each get one full viewport.

**Proof.** `app/just/ui-e2e-keys.sh` (`UI_E2E_SEGMENT=keys` of `ui-e2e.sh`) drives the
peer -> session -> message -> Knowledge -> publish -> revise -> cite -> correct -> supersede ->
history chain with ego-browser's `page.keyboard` only, and asserts `document.activeElement` at
each step. `app/just/ui-e2e.test.ts` checks statically that the segment never clicks, focuses,
sets values or navigates by hash. A failed screenshot remains a STEP_FAIL; this segment takes no
screenshots and is judged on its own steps.

**Reason.** The Codex acceptor judged #33 AC2 PARTIAL on `d949290`. The earlier harness drove forms
with value setters and DOM `.click`, DetailTabs had no tab semantics, and the 812x375 floor was
only disclosed. Ruling: `docs/overnight/DECISIONS.md` (the #33 AC2 slice; R12 for the model split).
Transcript and measurements: `docs/overnight/UI-PROOF-ui-keys.md`.

**Fix round (same slice, after the Opus verifier's REFUTED verdict).** A route `tab` that names no
tab (a stale or hand-typed `&tab=Nodes`) now keeps the strip reachable: `TabStrip` makes the first
tab the tab stop when no tab is selected (WAI-ARIA APG), and `App` coerces an unknown Explore tab to
`nodes` (`exploreTabOf`). Activating a view tab leaves focus on that tab even when the view opens a
node. The `short` layout sizes to `100svh`, not `100vh`. Rail rows (peers, sessions, node bookmarks)
carry `aria-current`. The focus moves are now pinned in CI by `keyboardFocus.test.tsx` (real
components on the fake DOM), not only by the ego-browser segment, which adds a `keys-stale-tab`
step (`ui-e2e/keysStaleTab.mjs`) and measures the Messages view at 812x375. Reason and ruling as
above (`docs/overnight/DECISIONS.md`, #33 AC2).

## Amendment 2026-09-26 (post-merge R7/R11/R17 + the audit's thin PASS rows)

Made by the `ac-evidence` slice, citing `docs/overnight/DECISIONS.md` and
`docs/overnight/AC-MATRIX.md` (#75 row "Scope: root-level evidence ... `delivery-gates.
md:51` still cites snapshot `11cf723`"). Appended, not an edit: every byte above is
unchanged, including the "Latest verification scope" section's own `11cf723` text.

**What changed.** That section's evidence snapshot (`11cf7235a815234d305f338982cf2cf
53ef21197`, dated 2026-09-20) predates issues #27-#34 entirely — it was never meant to
stand as evidence for tonight's overnight work, and the audit correctly found it stale
when read that way. This amendment does not replace that historical snapshot (it remains
correct for what it actually measured, at that commit); it adds a SLICE-SCOPED before/
after manifest for the `ac-evidence` slice specifically, with real git blob hashes
(`git hash-object`, not invented), so a reader has a non-stale reference point for this
slice's own changes.

**Manifest.** Base: `cefc8db` (`origin/main`, the merge of PR #122, this slice's branch
point). "Before" is the blob at that commit; "after" is the blob once this slice's edits
landed. A before hash of `e69de29b...` (the empty blob) means the file did not exist at
the base — it is new in this slice.

| File | Before (blob @ `cefc8db`) | After (blob, this slice) |
|---|---|---|
| `app/docs/contracts/read-cursor-v1.md` | `054bce347554190354b3cf594628cd3f028fd30d` | `8e538043f138164876f17a7c11cae61951e95e5a` |
| `app/migrate-py/tests/test_copy_migration.py` | `041be6c5fb25e3818d610a4870c966e16c49d046` | `aab50e2fbd81a27a0d6877eb3a5617014ea37174` |
| `app/server/test/trace-cycle-check.test.ts` | `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` (new) | `6b72f51ddb0e88444425c6511067638e4bc445ff` |
| `docs/overnight/AC-EVIDENCE.md` | `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` (new) | `a96a6d033f3c24202c14c1a55b907eb732a9682f` |
| `docs/overnight/AC-MATRIX.md` | `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` (new) | `f2b714bb89bdc6561e65ea2cefe1bf1e12100b5a` |
| `app/docs/contracts/delivery-gates.md` (this file) | `<computed after this edit lands, see the commit diff for its own before/after pair>` | — |

Reproduce with: `git cat-file -p <base>:<path> | git hash-object --stdin` for "before"
and `git hash-object <path>` for "after", from the `ac-evidence` slice worktree. Full
test evidence for the changes these blobs represent is in `docs/overnight/AC-EVIDENCE.md`
and the updated rows of `docs/overnight/AC-MATRIX.md`.

**Reverse by:** striking this section; the historical `11cf723` snapshot above is
unaffected either way.
