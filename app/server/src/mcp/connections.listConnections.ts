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
 * contract (`parseListConnections` / `encodeConnectionRow`) unchanged. The
 * target19 copy of this table stays declared and stays EMPTY until #34
 * migrates it (see the note beside `TARGET_SCHEMA` in `publication/storage.ts`).
 *
 * `requireWorkspace` is deliberately NOT called here, for the same reason as
 * the sibling `calls.listMcpCalls.ts`: the operations root's `workspaces`
 * table is not populated by a normal deployment, and admission already
 * bound `workspace_name` to the requested bank before this function runs.
 * Every predicate below is scoped by `request.workspace_name`, so no bank can
 * see another bank's rows.
 */
import { decodeArrowRows, quote, rawRows } from "../publication/storage";
import { MAX_RESULT_WIRE_BYTES, rowWireBytes } from "../publication/context";
import { encodeConnectionRow } from "../publication/context.encodeConnectionRow";
import { parseListConnections } from "../publication/context.parseListConnections";
import { failPublication } from "../publication/errors";
import { openConnectionsTable } from "./connections";

export async function listConnections(
  requestBytes: Uint8Array,
): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null; total: string | null }> {
  const request = parseListConnections(requestBytes);
  const tbl = await openConnectionsTable();
  await tbl.checkoutLatest();

  const workspaceScope = `workspace_name = ${quote(request.workspace_name)}`;
  const scope = request.after_id === null ? workspaceScope : `${workspaceScope} AND id > ${quote(request.after_id)}`;

  // KEYSET, never offset -- same total-order reasoning as the sibling
  // `calls.listMcpCalls.ts`: `id` is this table's unique primary key, one
  // row per (workspace, method, principal, label).
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
    if (ids.includes(id)) failPublication("integrity_failure", "");
    ids.push(id);
  }

  const page = ids.slice(0, request.limit);
  const rows: Record<string, unknown>[] = [];
  let budget = 1;
  for (const id of page) {
    const found = await rawRows(tbl, `${workspaceScope} AND id = ${quote(id)}`, 2);
    if (found.length === 0) failPublication("integrity_failure", "");
    if (found.length > 1) failPublication("integrity_failure", "");
    const encoded = encodeConnectionRow(found[0]!);
    budget += rowWireBytes(encoded) + 1;
    if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
    rows.push(encoded);
  }

  const total = request.include_total ? (await tbl.countRows(workspaceScope)).toString(10) : null;

  const hasMore = ids.length > request.limit;
  return {
    rows,
    next_after_id: hasMore && page.length > 0 ? page[page.length - 1]! : null,
    total,
  };
}
