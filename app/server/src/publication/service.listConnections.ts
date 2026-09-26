import { MAX_RESULT_WIRE_BYTES, rowWireBytes } from "./context";
import { encodeConnectionRow } from "./context.encodeConnectionRow";
import { parseListConnections } from "./context.parseListConnections";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { CONNECTIONS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/**
 * UNROUTED as of DECISIONS.md R5 (#102) -- see `service.listMcpCalls.ts`'s
 * comment for the full reasoning, which applies here unchanged. `foldConnection`
 * (`app/server/src/mcp/connections.ts`) writes into the operations root
 * (`ARRA_DATA_DIR`); this function reads the DIFFERENT `ARRA_KNOWLEDGE_DATASET_ROOT`
 * dataset, which nothing folds `connections` into, so it always answers
 * correctly from an empty table. `knowledge/registry.ts`'s `listConnections`
 * entry now carries an `operations` field (`mcp/connections.listConnections.ts`)
 * that the transport calls instead. This function is kept, untouched, for
 * the #34 cutover.
 */
export async function listConnections(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null; total: string | null }> {
  const request = parseListConnections(requestBytes);
  await requireWorkspace(reader, request.workspace_name);
  await reader.refresh(CONNECTIONS);

  const scope =
    `${contextScope(request.workspace_name)}` +
    (request.after_id === null ? "" : ` AND id > ${quote(request.after_id)}`);

  // KEYSET, never offset. `id` is this table's unique primary key -- the
  // same total-order reasoning as `service.listMcpCalls.ts`'s comment on the
  // same shape (one row per caller, so `id` never ties within a workspace).
  const selected = await reader.orderedProjection(
    CONNECTIONS,
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
    const row = await contextOne(reader, CONNECTIONS, `${contextScope(request.workspace_name)} AND id = ${quote(id)}`);
    if (row === null) failPublication("integrity_failure", "");
    const encoded = encodeConnectionRow(row);
    budget += rowWireBytes(encoded) + 1;
    if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
    rows.push(encoded);
  }

  // The count uses the SAME scoped predicate as the page, minus the cursor:
  // a total that counted a different set than the page walks would be worse
  // than no total at all. Filters (tool/status) stay IN it, because "how many
  // errored" is the question this table exists to answer.
  const total = request.include_total
    ? (await reader.count(CONNECTIONS, contextScope(request.workspace_name))).toString(10)
    : null;

  const hasMore = ids.length > request.limit;
  return {
    rows,
    next_after_id: hasMore && page.length > 0 ? page[page.length - 1]! : null,
    total,
  };
}
