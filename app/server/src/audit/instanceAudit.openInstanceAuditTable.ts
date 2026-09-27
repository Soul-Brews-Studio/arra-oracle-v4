// The one place the `instance_audit` connection is opened (#31 maint-audit,
// Nat 2026-09-28 D4b).
//
// `POST /api/backfill` and `POST /api/reindex` admit a GLOBAL action — no
// workspace, and `mcp_calls.workspace_name` is NOT NULL, so neither route can
// write a row there without a sentinel workspace, which D4b forbids. This is
// a SEPARATE table at the same server data root (`DATA_DIR`, `../storage.ts`)
// that `mcp_calls` already lives at — a dedicated Lance dataset, not a
// workspace one, matching the existing idiom (`mcp/calls.openCallLogTable.ts`)
// rather than introducing a new storage mechanism (JSONL) for one audit sink.
//
// One cached connection, like the call-log table. `ensureInstanceAuditTable`
// creates the table from the FIRST row it is ever called with (Lance infers
// schema from data, same as every other table in this codebase) and returns
// the open handle either way, so the caller always ends by `.add`-ing its row
// — the create path never double-writes the sample.

import { connect } from "@lancedb/lancedb";
import { DATA_DIR, storageOptions } from "../storage";

const TABLE = "instance_audit";

let handle: Awaited<ReturnType<typeof connect>> | null = null;

export async function ensureInstanceAuditTable(
  sample: Record<string, unknown>,
): Promise<{ table: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["openTable"]>>; wroteSample: boolean }> {
  handle ??= await connect(DATA_DIR, { storageOptions: storageOptions() });
  const names = await handle.tableNames();
  if (names.includes(TABLE)) return { table: await handle.openTable(TABLE), wroteSample: false };
  return { table: await handle.createTable(TABLE, [sample]), wroteSample: true };
}
