// Opens the schema created by the active Python migration. This file never defines the schema -- if the table
// is missing, that is a migration that did not run, not something to paper over.
import { connect } from "@lancedb/lancedb";
import type { Table } from "@lancedb/lancedb";
import { DATA_DIR, storageOptions } from "./storage";
import { TABLE, dbState } from "./db.state";

// A Table handle is a pinned snapshot, not a live view: it keeps serving the
// version it was opened at, so writes from another process (a Python migration,
// a second server, a backfill worker) stay invisible until checkoutLatest().
// Read-your-own-writes within one process works without it -- cross-process does not.
export async function db(): Promise<Table> {
  dbState.conn ??= await connect(DATA_DIR, { storageOptions: storageOptions() });
  if (!dbState.table) {
    const names = await dbState.conn.tableNames();
    if (!names.includes(TABLE)) {
      throw new Error(`table '${TABLE}' not found in ${DATA_DIR}. Run 'just migrate run-legacy' (python -m arra_migrate --legacy-active15) first.`);
    }
    dbState.table = await dbState.conn.openTable(TABLE);
    return dbState.table;
  }
  await dbState.table.checkoutLatest();
  return dbState.table;
}
