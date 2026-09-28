// Module-level singleton state for the legacy `memories` table adapter
// (#22 style-split4a). DATA ONLY -- no functions here, so every split file
// that touches `conn`/`table` shares the SAME identity instead of each
// getting its own module-scoped `let`. See db.db.ts for why a Table handle
// is a pinned snapshot, not a live view.
import type { Connection, Table } from "@lancedb/lancedb";

export const TABLE = "memories";

export const dbState: { conn: Connection | null; table: Table | null } = {
  conn: null,
  table: null,
};
