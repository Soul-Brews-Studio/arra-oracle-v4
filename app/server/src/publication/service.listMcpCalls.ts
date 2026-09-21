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

export async function listMcpCalls(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null }> {
  const request = parseListMcpCalls(requestBytes);
  await requireWorkspace(reader, request.workspace_name);
  await reader.refresh(MCP_CALLS);

  let scope = contextScope(request.workspace_name);
  if (request.after_id !== null) scope += ` AND id > ${quote(request.after_id)}`;
  if (request.tool !== null) scope += ` AND tool = ${quote(request.tool)}`;
  if (request.status !== null) scope += ` AND status = ${quote(request.status)}`;

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

  const hasMore = ids.length > request.limit;
  return {
    rows,
    next_after_id: hasMore && page.length > 0 ? page[page.length - 1]! : null,
  };
}
