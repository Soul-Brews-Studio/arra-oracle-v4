import { failPublication } from "./errors";
import { quote } from "./storage";
import { encodeTraceRow } from "./trace";
import { TRACES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * Walk an existing trace ancestry chain, bounded, over EITHER pointer column.
 *
 * Mirrors `assertReplyChain`. `start` is the row the caller's `parent_id` or
 * `prev_id` ALREADY resolved to -- an invalid_reference at that pointer is
 * decided by the caller before this runs. Everything found from here on is
 * STORED state: a broken link, a self-referencing cycle or a chain longer
 * than 1024 stored ancestors is corruption or a limit, never the caller's
 * invalid_reference. The row being created is not yet in the table and is
 * not counted.
 */
export async function assertTraceChain(
  adapter: DatasetAdapter,
  workspace: string,
  start: Record<string, unknown>,
  pointerField: "parent_id" | "prev_id",
): Promise<void> {
  let cursor: Record<string, unknown> | null = start;
  let visited = 0;
  const seen = new Set<string>();
  while (cursor !== null) {
    visited += 1;
    if (visited > 1024) failPublication("limit_exceeded", "");
    const encoded = encodeTraceRow(cursor);
    const id = encoded.id as string;
    if (seen.has(id)) failPublication("integrity_failure", "");
    seen.add(id);
    if (encoded.workspace_name !== workspace) failPublication("integrity_failure", "");
    const next = encoded[pointerField] as string | null;
    if (next === null) return;
    cursor = await contextOne(adapter, TRACES, `${contextScope(workspace)} AND id = ${quote(next)}`);
    if (cursor === null) failPublication("integrity_failure", "");
  }
}
