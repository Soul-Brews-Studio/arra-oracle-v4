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
 * unchanged so a caller cannot tell which physical root answered. The
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
import { decodeArrowRows, quote, rawRows } from "../publication/storage";
import { MAX_RESULT_WIRE_BYTES, rowWireBytes } from "../publication/context";
import { encodeMcpCallRow } from "../publication/context.encodeMcpCallRow";
import { parseListMcpCalls } from "../publication/context.parseListMcpCalls";
import { failPublication } from "../publication/errors";
import { openCallLogTable } from "./calls";

export async function listMcpCalls(
  requestBytes: Uint8Array,
): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null; total: string | null }> {
  const request = parseListMcpCalls(requestBytes);
  const tbl = await openCallLogTable();
  await tbl.checkoutLatest();

  const workspaceScope = `workspace_name = ${quote(request.workspace_name)}`;
  // Two predicates, deliberately, matching the target19 reader this mirrors:
  // `countScope` is the SET (workspace plus any tool/status filter); `scope`
  // narrows it to the current PAGE with the cursor. A total that counted a
  // different set than the page walks would be worse than no total at all.
  let countScope = workspaceScope;
  if (request.tool !== null) countScope += ` AND tool = ${quote(request.tool)}`;
  if (request.status !== null) countScope += ` AND status = ${quote(request.status)}`;
  const scope = request.after_id === null ? countScope : `${countScope} AND id > ${quote(request.after_id)}`;

  // KEYSET, never offset: limit+1 detects continuation without paging by
  // position. `id` (`c_<base36ms>_<random6>`, minted by `calls.ts`) is a
  // total order for this purpose -- the table's unique primary key.
  const arrow = await tbl
    .query()
    .where(scope)
    .select(["id"])
    .orderBy([{ columnName: "id", ascending: true }])
    .limit(request.limit + 1)
    .toArrow();
  const selected = decodeArrowRows(arrow);

  const ids: string[] = [];
  for (const row of selected) {
    const id = row.id;
    if (typeof id !== "string") failPublication("integrity_failure", "");
    // The LOOKAHEAD row is validated too: a duplicate straddling the limit
    // would otherwise evade the check and split silently across two pages.
    if (ids.includes(id)) failPublication("integrity_failure", "");
    ids.push(id);
  }

  const page = ids.slice(0, request.limit);
  const rows: Record<string, unknown>[] = [];
  // Cumulative wire budget: over budget fails, it never truncates, which
  // would hand back a short page indistinguishable from a real one.
  let budget = 1;
  for (const id of page) {
    // Re-fetched by exact identity (workspace + id only, no tool/status),
    // matching `service.listMcpCalls.ts`: the id already came from the
    // filtered scope, so this is an integrity re-check, not a second filter.
    const found = await rawRows(tbl, `${workspaceScope} AND id = ${quote(id)}`, 2);
    if (found.length === 0) failPublication("integrity_failure", "");
    if (found.length > 1) failPublication("integrity_failure", "");
    const encoded = encodeMcpCallRow(found[0]!);
    budget += rowWireBytes(encoded) + 1;
    if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
    rows.push(encoded);
  }

  const total = request.include_total ? (await tbl.countRows(countScope)).toString(10) : null;

  const hasMore = ids.length > request.limit;
  return {
    rows,
    next_after_id: hasMore && page.length > 0 ? page[page.length - 1]! : null,
    total,
  };
}
