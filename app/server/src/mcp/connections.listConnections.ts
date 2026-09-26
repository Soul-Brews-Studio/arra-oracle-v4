/**
 * The operations-root reader for `connections` (#102, DECISIONS.md R5).
 *
 * `foldConnection` (`connections.ts`) writes every admitted MCP request into
 * `ARRA_DATA_DIR` -- the operations root. Before this file existed, the only
 * `listConnections` reader was `publication/service.listConnections.ts`,
 * which opens the DIFFERENT physical `ARRA_KNOWLEDGE_DATASET_ROOT` dataset
 * that nothing folds `connections` into. R5 rules that `mcp_calls` and
 * `connections` stay operations tables in the operations root; this function
 * reads the table the writer actually fills, reusing the target19 wire
 * contract (`parseListConnections` / `encodeConnectionRow`) unchanged, plus
 * the fix-round 2 `unreadable` report for rows that codec rejects or that
 * share an id (`operations.listPage.ts`) -- the pre-R5 fold is known to have
 * left duplicate ids in real stores, and they must not deny the listing for
 * the whole workspace. The target19 copy of this table stays declared and stays EMPTY until #34
 * migrates it (see the note beside `TARGET_SCHEMA` in `publication/storage.ts`).
 *
 * `requireWorkspace` is deliberately NOT called here, for the same reason as
 * the sibling `calls.listMcpCalls.ts`: the operations root's `workspaces`
 * table is not populated by a normal deployment, and admission already
 * bound `workspace_name` to the requested bank before this function runs.
 * Every predicate below is scoped by `request.workspace_name`, so no bank can
 * see another bank's rows.
 */
import { encodeConnectionRow } from "../publication/context.encodeConnectionRow";
import { parseListConnections } from "../publication/context.parseListConnections";
import { quote } from "../publication/storage";
import { openConnectionsTable } from "./connections.openConnectionsTable";
import { listPage } from "./operations.listPage";

/** LanceDB's own message for a missing table, naming THIS table -- see the
 *  measurement and the fix-round 2 note beside the sibling in
 *  `calls.listMcpCalls.ts`. Tested against `openTable`'s error only. */
const TABLE_ABSENT = /Table 'connections' was not found/;

export async function listConnections(requestBytes: Uint8Array): ReturnType<typeof listPage> {
  const request = parseListConnections(requestBytes);
  let tbl: Awaited<ReturnType<typeof openConnectionsTable>>;
  try {
    tbl = await openConnectionsTable();
  } catch (error) {
    // See the sibling comment in `calls.listMcpCalls.ts`: a missing
    // `connections` table reads as empty, never as a raw SDK message (which
    // would carry the dataset path) reaching an MCP client.
    if (error instanceof Error && TABLE_ABSENT.test(error.message)) {
      return { rows: [], next_after_id: null, total: request.include_total ? "0" : null };
    }
    throw error;
  }
  await tbl.checkoutLatest();

  // No filters on this method: the SET is the workspace. `id` is the fold
  // key, one row per (workspace, method, principal, label) -- and the keyset
  // order.
  const workspace = `workspace_name = ${quote(request.workspace_name)}`;
  const page = request.after_id === null ? workspace : `${workspace} AND id > ${quote(request.after_id)}`;
  return listPage(tbl, { workspace, count: workspace, page }, request.limit, request.include_total, encodeConnectionRow);
}
