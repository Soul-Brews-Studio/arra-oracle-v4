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

## Amendment 2026-09-28 (slice `legacy-s2-t19-memory-read`, S2 build)

S2 (the target-19 read path for memories, behind a flag, default off) is built:
`db.legacyRead.getById.ts` / `db.legacyRead.list.ts` / `db.legacyRead.searchText.ts` /
`db.legacyRead.searchVector.ts`, gated by `ARRA_MEMORIES_BACKEND` (`db.legacyRead.backend.ts`;
default `"legacy"`, unchanged behaviour) and wired at the `db.getById`/`db.list`/`db.searchText`/
`db.searchVector` boundary itself, so `db.ts`'s own barrel and every existing caller
(`/api/memories`, the v3-compat MCP tools) are untouched.

Each reads through `db.legacyRead.openTarget19MemoryReader.ts` (`composeKnowledgeAccess` +
`getBundle("content:read")`, a reviewed doorway, cached for the process lifetime) and calls the
existing #29/#30 kernels -- `getAcceptedHead`, `listNodes`, `searchKnowledgeKeyword`,
`searchKnowledgeSemantic` -- never opens a dataset or a writer directly.
`db.legacyRead.mapAcceptedHeadToMemory.ts` maps one node + head revision + lifecycle label back
to the EXACT `db.clean.ts` wire shape, the reverse of `migration/buildRevisionRequest.ts`:
- `type` reads the `legacy_type` term snapshot when present (the original legacy string, R11),
  else the reserved `type` term.
- `peer_name` is lossy going forward (the legacy writer's field is never carried by
  `buildRevisionRequest.ts`, only `internal_metadata.legacy_peer_name` when a caller sets it) --
  read back from there, `null` otherwise. This is the one field S2 cannot round-trip; S3 (pointing
  `remember`/`recall` at target-19 directly) does not have this gap, since it never goes through
  the legacy shape at all.
- `sync_state`/`superseded_by` derive from the #29 lifecycle label (`"synced"` when not terminal);
  `last_sync_at`/`superseded_at` and the stored `embedding` vector have no target-19 equivalent at
  the node/revision layer and read as absent (`null`/`embedded: false`), same as `db.clean.ts`'s
  own `score`/`distance` being `undefined` outside a search.
- `db.legacyRead.list.ts` walks `listNodes`' `after_id` keyset (its own `MAX_PAGE_LIMIT` page
  ceiling) and applies every legacy filter (`type`, `session_name`, `peer_name`,
  `subject_peer_name`, `sync_state`, `is_active`) in the mapped shape, since `listNodes` itself has
  no equivalent of those filters; a `type_term`-id-based push-down is future work, left to S3.

Tested by `test/legacy-read-target19-parity.test.ts`: a real target-19 fixture seeded through the
real `publishRevision`/`indexRevisionChunks` writer path (gated child,
`test/fixtures/legacy-read-target19/gated-publish-and-index.ts`), `ARRA_MEMORIES_BACKEND` unset
proven to leave the legacy path untouched (rejects rather than silently reading the target-19
fixture), and flag-on coverage of `getById`, workspace-scoped `list` (cross-workspace exclusion),
and Thai-substring `searchText` (R14 ngram, "ลืม" inside "หลงลืม"). `searchVector` is implemented
against the same `searchKnowledgeSemantic` kernel but not covered by this test round (it needs a
composed query embedder in-process; deferred, noted in the slice report's `deviations_from_ruling`).
