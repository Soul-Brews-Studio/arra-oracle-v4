/**
 * The operations-root reader for `mcp_calls` (#103, DECISIONS.md R5).
 *
 * `logCall` (`calls.ts`) writes every admitted MCP request into
 * `ARRA_DATA_DIR` -- the operations root. Before this file existed, the only
 * `listMcpCalls` reader was `publication/service.listMcpCalls.ts`, which
 * opens a DIFFERENT physical dataset, `ARRA_KNOWLEDGE_DATASET_ROOT`. Nothing
 * writes `mcp_calls` there, so that reader always answered an empty page --
 * measured on this checkout: three real MCP calls produced three rows in the
 * operations root and zero in the knowledge dataset
 * (`.tmp/understand/analysis-103.json`).
 *
 * R5 rules that `mcp_calls` and `connections` stay operations tables in the
 * operations root; this function reads the table the writer actually fills,
 * reusing the target19 wire contract (`parseListMcpCalls` / `encodeMcpCallRow`)
 * unchanged so a caller cannot tell which physical root answered -- with one
 * addition from fix round 2: a stored row that codec rejects is withheld and
 * reported in `unreadable` instead of failing the whole workspace's listing
 * (`operations.listPage.ts`, which also holds the paging itself). The
 * target19 copy of this table stays declared and stays EMPTY until #34
 * migrates it (see the note beside `TARGET_SCHEMA` in `publication/storage.ts`).
 *
 * `requireWorkspace` is deliberately NOT called here: the operations root's
 * own `workspaces` table is a legacy migration artifact that nothing
 * populates in a normal deployment (`arra-migrate` creates it empty; contrast
 * the target19 test fixtures, which do seed it for the unrouted reader
 * above). The caller reaches this function only because admission already
 * bound `workspace_name` to the requested route/tool bank (`transport.ts`'s
 * `peekWorkspaceName` for HTTP, `mcp/index.ts`'s `readWorkspaceAtPlain` for
 * MCP), so an unknown bank answers an empty page here rather than
 * `invalid_reference` -- a documented behaviour change from the unrouted
 * target19 reader, not a new isolation hole: no bank can ever see another
 * bank's rows, because every predicate below is scoped by
 * `request.workspace_name`.
 */
import { encodeMcpCallRow } from "../publication/context.encodeMcpCallRow";
import { parseListMcpCalls } from "../publication/context.parseListMcpCalls";
import { quote } from "../publication/storage";
import { openCallLogTable } from "./calls.openCallLogTable";
import { listPage } from "./operations.listPage";

/**
 * LanceDB's own message for a missing table, naming THIS table (measured on
 * 0.38: "Table 'mcp_calls' was not found  Caused by: Dataset at path ...").
 * Fix-round 2 finding: the earlier bare `/was not found/` could have turned
 * an unrelated not-found storage error into a silently empty page. It is now
 * also tested against `openTable`'s error only, never `checkoutLatest`'s.
 */
const TABLE_ABSENT = /Table 'mcp_calls' was not found/;

export async function listMcpCalls(requestBytes: Uint8Array): ReturnType<typeof listPage> {
  const request = parseListMcpCalls(requestBytes);
  let tbl: Awaited<ReturnType<typeof openCallLogTable>>;
  try {
    tbl = await openCallLogTable();
  } catch (error) {
    // A store with no `mcp_calls` table (an unmigrated `ARRA_DATA_DIR`, or a
    // fresh deployment nothing has written to yet) is equivalent to an empty
    // table from this reader's point of view -- NOT an error the caller
    // should see. Before this branch existed, the raw LanceDB SDK message
    // (including the dataset path) reached the client verbatim over MCP,
    // which `revision-publication-v1.md` / `context-ingestion-v1.md` both
    // forbid for every OTHER governed method; HTTP already maps unknown
    // errors to a bare `{"error":"internal"}` (`knowledge/transport.ts`), but
    // MCP's `tool_error` path (`auth/service.ts`) carries `error.message`
    // through unchanged, so this had to be stopped here, at the source.
    if (error instanceof Error && TABLE_ABSENT.test(error.message)) {
      return { rows: [], next_after_id: null, total: request.include_total ? "0" : null };
    }
    throw error;
  }
  await tbl.checkoutLatest();

  const workspace = `workspace_name = ${quote(request.workspace_name)}`;
  // Two predicates, deliberately, matching the target19 reader this mirrors:
  // `count` is the SET (workspace plus any tool/status filter); `page`
  // narrows it with the cursor. A total that counted a different set than
  // the page walks would be worse than no total at all.
  let count = workspace;
  if (request.tool !== null) count += ` AND tool = ${quote(request.tool)}`;
  if (request.status !== null) count += ` AND status = ${quote(request.status)}`;
  const page = request.after_id === null ? count : `${count} AND id > ${quote(request.after_id)}`;

  // `id` (`c_<base36ms>_<random6>`, minted by `calls.ts`) is the table's
  // unique primary key and the keyset order.
  return listPage(tbl, { workspace, count, page }, request.limit, request.include_total, encodeMcpCallRow);
}
