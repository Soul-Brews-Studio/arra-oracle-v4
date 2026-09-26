import { MAX_RESULT_WIRE_BYTES, rowWireBytes } from "./context";
import { encodeMcpCallRow } from "./context.encodeMcpCallRow";
import { parseListMcpCalls } from "./context.parseListMcpCalls";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { MCP_CALLS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/**
 * UNROUTED as of DECISIONS.md R5 (#103) -- kept for the #34 cutover, not
 * reachable from any transport today.
 *
 * This function reads `reader`, which `service.openContextReader` /
 * `service.openEvidenceReader` open against `ARRA_KNOWLEDGE_DATASET_ROOT`
 * (the target19 "knowledge" dataset). `logCall` (`app/server/src/mcp/calls.ts`)
 * writes every admitted MCP request into a DIFFERENT physical dataset,
 * `storage.ts`'s `DATA_DIR` (`ARRA_DATA_DIR`, the operations root) -- so this
 * function, called directly, always answers correctly from an empty table:
 * measured on a live server, three real MCP `tools/call` invocations produced
 * three audited rows in the operations root and ZERO here.
 *
 * R5 ruled option B: the operations tables (`mcp_calls`, `connections`) stay
 * in the operations root, and the READS move there instead of the writer
 * moving here. `knowledge/registry.ts`'s `listMcpCalls` entry now carries an
 * `operations` field (`mcp/calls.listMcpCalls.ts`) that the transport calls
 * INSTEAD of this function -- see `knowledge/transport.ts`'s
 * `handleKnowledgeRequest` and `mcp/index.ts`'s `dispatchKnowledgeTool`. This
 * function itself is untouched and stays exactly correct for the dataset it
 * reads; it becomes live again only once #34 migrates `mcp_calls` into the
 * dataset this reader actually opens, at which point the registry's
 * `operations` field is the thing to remove. `connections` (sibling
 * `service.listConnections.ts`) has the identical shape and the identical
 * ruling.
 */
export async function listMcpCalls(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null; total: string | null }> {
  const request = parseListMcpCalls(requestBytes);
  await requireWorkspace(reader, request.workspace_name);
  await reader.refresh(MCP_CALLS);

  // Two predicates, deliberately. `countScope` is the SET: workspace plus any
  // tool/status filter. `scope` is that set narrowed to the current PAGE by
  // the cursor.
  //
  // They were one variable, and the count used it. That made `total` shrink
  // as you paged -- page three of twenty reported a total of seventeen --
  // because the cursor had already excluded the rows behind you. A total
  // that counts a different set than the page walks is worse than no total,
  // and this one silently agreed with itself on page one.
  let countScope = contextScope(request.workspace_name);
  if (request.tool !== null) countScope += ` AND tool = ${quote(request.tool)}`;
  if (request.status !== null) countScope += ` AND status = ${quote(request.status)}`;
  const scope =
    request.after_id === null ? countScope : `${countScope} AND id > ${quote(request.after_id)}`;

  // KEYSET, never offset: limit+1 detects continuation without paging by
  // position, which would skip or repeat rows as the table grows.
  //
  // `id` (`c_<base36ms>_<random6>`, written by `mcp/calls.ts`) is a TOTAL
  // order for this purpose: it is the table's unique primary key, so
  // lexicographic string ordering never ties and never needs a second
  // tie-break column, exactly like `search_chunks_v1.chunk_index` is a real
  // total order in `service.listSearchChunks.ts` because it too is unique in
  // scope. It is NOT claimed to be chronological -- same-millisecond calls
  // can sort by their random suffix instead of arrival order -- only that it
  // is a stable, gap-free cursor.
  const selected = await reader.orderedProjection(
    MCP_CALLS,
    scope,
    ["id"],
    { column: "id", ascending: true },
    request.limit + 1,
  );

  const ids: string[] = [];
  for (const row of selected) {
    const id = row.id;
    if (typeof id !== "string") failPublication("integrity_failure", "");
    // The LOOKAHEAD row is validated too, not just the emitted page: a
    // duplicate straddling the limit would otherwise evade the check and
    // split silently across two pages.
    if (ids.includes(id)) failPublication("integrity_failure", "");
    ids.push(id);
  }

  const page = ids.slice(0, request.limit);
  const rows: Record<string, unknown>[] = [];
  // Cumulative wire budget, matching listMessages: over budget fails, it
  // never truncates, which would hand back a short page indistinguishable
  // from a real one.
  let budget = 1;
  for (const id of page) {
    // Re-fetched by exact identity, not taken from the projection: the
    // projection above only carries the ordering column, matching
    // `service.listMessages.ts`'s split between "which rows" and "what they
    // contain".
    const row = await contextOne(reader, MCP_CALLS, `${contextScope(request.workspace_name)} AND id = ${quote(id)}`);
    if (row === null) failPublication("integrity_failure", "");
    const encoded = encodeMcpCallRow(row);
    budget += rowWireBytes(encoded) + 1;
    if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
    rows.push(encoded);
  }

  // The count uses the SAME scoped predicate as the page, minus the cursor:
  // a total that counted a different set than the page walks would be worse
  // than no total at all. Filters (tool/status) stay IN it, because "how many
  // errored" is the question this table exists to answer.
  const total = request.include_total
    ? (await reader.count(MCP_CALLS, countScope)).toString(10)
    : null;

  const hasMore = ids.length > request.limit;
  return {
    rows,
    next_after_id: hasMore && page.length > 0 ? page[page.length - 1]! : null,
    total,
  };
}
