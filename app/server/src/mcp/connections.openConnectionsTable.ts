// The one place the operations-root `connections` table is opened (#102,
// DECISIONS.md R5).
//
// The fold (`connections.ts`'s `foldConnection`) and the R5 reader
// (`connections.listConnections.ts`) both come through here, so they resolve
// `ARRA_DATA_DIR` in exactly one place and share ONE cached connection. Its
// own file because it is a new export, and `connections.ts` already exports
// several (one exported function per file, fix-round 2 style finding).
//
// The cached connection is never dropped, including by
// `resetConnectionFoldState`: it holds no table state worth resetting.
// Measured (2026-09-26, LanceDB 0.38, fresh mktemp root): a connection that
// had already failed `openTable("connections")` opened it fine once another
// connection created it, and saw a later write from that other connection
// too. Every call below re-opens the table from the manifest.

import { connect } from "@lancedb/lancedb";
import { OPS_DIR, opsStorageOptions } from "../storage.opsRoot";

const TABLE = "connections";

let handle: Awaited<ReturnType<typeof connect>> | null = null;

// R33 S4(a) (Nat 2026-09-28, docs/overnight/DECISIONS.md): this table lives
// under `ARRA_OPS_DIR` when set, else falls back to `ARRA_DATA_DIR` unchanged
// (`storage.opsRoot.ts`).
export async function openConnectionsTable() {
  handle ??= await connect(OPS_DIR, { storageOptions: opsStorageOptions() });
  return handle.openTable(TABLE);
}
