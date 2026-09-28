# Plan: retire the legacy 15-table root

Status: **accepted**, 2026-09-28. Written by a Sonnet planning agent and read through by v4-overnight.
Nat ruled on both open steps (R33): **S3 (a)**, where the v3 tool names and wire shapes stay frozen and only the internals move to target-19; and **S4 (a)**, where the operations tables move to a sibling Lance root, `ARRA_OPS_DIR`.

## Why

After R32 (#157), `python -m arra_migrate` creates target-19 by default. The server still needs a
legacy root in `ARRA_DATA_DIR`, so a fresh v4 creates 15 legacy tables alongside the 19.

## 1. What uses the legacy root

**Hard gate.** `app/server/src/db.db.ts` throws if `memories` is absent.

**Legacy memory adapters.** The `db.ts` barrel re-exports `db.db`, `db.insert`,
`db.ensureFtsIndex`, `db.searchText`, `db.searchVector`, `db.list`, `db.getById`, `db.backfill`
and `db.state`.

**HTTP.** `/api/memories` in `app.createApp.ts`, together with `app.plainBody.ts`.

**MCP v3-compat tools.** `mcp/index.dispatchTool.ts` handles `remember`, `recall`, `get_memory` and
`list_memories`. They are gated by `ARRA_MCP_V3_COMPAT` in `composition.composeV3Compat.ts`.

**Operations tables (R5).** These share the same `DATA_DIR`:
- `mcp/calls.openCallLogTable.ts`
- `mcp/connections.openConnectionsTable.ts`
- `audit/instanceAudit.openInstanceAuditTable.ts` (R25)

**Other readers.**
- CLI: `app/cli.ts`
- UI: `ui/v2/src/overview/OverviewView.tsx`, `api/audit.ts`
- just recipes: `app/justfile`, `app/just/{data,server,migrate}.just`, `dev-stack.sh`,
  `demo.sh`, `demo/{stack,v3}.sh`, `scripts/run_dev_server.py`
- Python: `arra_migrate/__main__.py` (`--legacy-active15`), `storage.py`, `copy_migration/*`,
  the rehearsal modules

**Tests.**
- `mcp-correctness`
- `mcp-v3-*`
- `mcp-remember-taxonomy`
- `remember-taxonomy-parity`
- `fts-service`
- `transport-audit-instance`
- `instance-audit-reader`
- `migration-copy`
- `auth-transport`
- `auth-integration`
- the Python tests `test_migrate_default`, `test_target_schema_v1` and `test_migration_lanes`

## 2. Where each responsibility moves

- **Legacy memories move to target-19 nodes and revisions.** The v3-compat tools and
  `/api/memories` call the same publish path the copy migration uses
  (`migration/publishPlannedMemory.ts`, `buildRevisionRequest.ts`, `deriveProjections.ts`).
  Target-19 search (chunks plus FTS) replaces `db.searchText` and `db.searchVector`.
- **Operations tables move to one place, still to be decided (S4).** The rules they must keep:
  `workspace_name NOT NULL` for `mcp_calls` and `connections` (R5), and no workspace for the R25
  instance log.

## 3. Compatibility fences

- **v3 client wire contract.** Parameters and response shapes stay byte-identical. The
  `mcp-v3-*` suites stay unmodified and act as the regression fence.
- **Migration-copy golden MCP JSON.** The goldens are regenerated only in the final slice.
  Until then the old ones stay tagged as legacy.
- **`/api/memories`.** Freeze its response shape as a contract before the backing store
  changes.
- **Amendments.** Append amendments; never edit frozen text. Candidates:
  - DECISIONS R5, which says "operations root", while the code shares `DATA_DIR`. That
    contradiction already exists.
  - `target-v1-decisions.md`
  - `revision-publication-v1.md`
  - `authorization-integration-v1.md`

## 4. Staged slices

Each slice can be merged on its own and has its own tests.

| Slice | Size | What it does | Ruling needed | Reverse by |
|---|---|---|---|---|
| S1 | S | Instrument every legacy-root open. Confirm the inventory under the full suite and a demo session. | — | Remove the instrumentation |
| S2 | M | Build the target-19 read path for memories (search and FTS parity) behind a flag, turned off by default. | — | Turn the flag off |
| S3 | M–L | Point `remember`, `recall`, `get_memory` and `list_memories` at target-19. | **Yes** (below) | Point the dispatch cases back at `db.*` |
| S4 | M | Move the operations tables. | **Yes** (below) | Point the openers back at `DATA_DIR` |
| S5 | S–M | Move the `/api/memories` handlers onto target-19. | — | Revert the handler bodies |
| S6 | S | Delete the `db.db.ts` gate, the `db.*` legacy adapters and `just migrate run-legacy`. | Only if something outside this repo uses `--legacy-active15` | Restore from git |
| S7 | S | Regenerate the migration-copy goldens and drop the legacy fixtures. | — | Keep the old goldens tagged |

**S3 options:**
- (a) Keep the tool names and response shapes frozen, and swap only the internals.
- (b) Deprecate the tools in favour of the native `kb_*` tools, behind a compat shim.
- (c) Set a sunset date for `ARRA_MCP_V3_COMPAT`.

**S4 options:**
- (a) Add a sibling Lance dataset, `ARRA_OPS_DIR`.
- (b) Fold the three tables into the target registry as extra tiers.
- (c) Move only `mcp_calls` and `connections`, and leave `instance_audit` where it is.

## 5. Proof

- **Static check.** `rg "DATA_DIR" app/server/src` shows only the operations-root openers, and
  nothing references `memories` or `db.db`.
- **Dynamic check.** S1's instrumentation shows zero legacy-table opens across the full suite
  and a demo session.
- **Fresh-install probe.** Run the default migrator only, on a scratch root with no
  `--legacy-active15`. Start the server, exercise `/api/memories`, `remember` and `recall`, and
  confirm no `memories` table is ever created.
- **Test suites.** `migration-copy`, `mcp-v3-*`, `fts-service` and the two instance-audit suites
  pass on fixtures that contain only target-19.
