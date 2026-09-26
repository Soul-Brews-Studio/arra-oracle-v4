// The one place the operations-root `mcp_calls` table is opened (#103,
// DECISIONS.md R5).
//
// The writer (`calls.ts`'s `logCall`), the legacy readers (`recent`,
// `aggregate`) and the R5 reader (`calls.listMcpCalls.ts`) all come through
// here, so they resolve `ARRA_DATA_DIR` in exactly one place and share ONE
// cached connection rather than opening a second handle to the same store.
// Its own file because it is a new export, and `calls.ts` already exports
// several (one exported function per file, fix-round 2 style finding).

import { connect } from "@lancedb/lancedb";
import { DATA_DIR, storageOptions } from "../storage";

const TABLE = "mcp_calls";

let handle: Awaited<ReturnType<typeof connect>> | null = null;

export async function openCallLogTable() {
  handle ??= await connect(DATA_DIR, { storageOptions: storageOptions() });
  return handle.openTable(TABLE);
}
