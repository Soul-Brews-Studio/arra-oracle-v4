import { failPublication } from "./errors";
import { encodeSupersedeLogRow } from "./lifecycle";
import { quote } from "./storage";
import { MAX_CHAIN_WALK, SUPERSEDE_LOG } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { type DatasetAdapter } from "./service.types";

/**
 * Walk the supersede_log chain forward from `startId`, following each
 * `new_id` link, up to MAX_CHAIN_WALK hops.
 *
 * A repeated id met during the walk is a CYCLE ALREADY PRESENT in stored
 * data -- corruption, at root. Exceeding the bound without terminating is a
 * limit, not corruption: the chain may be healthy and merely long. Both are
 * distinct from the caller's own immediate self-reference, which is checked
 * before this walk ever runs and reported against the request instead.
 */
export async function walkForwardChain(
  adapter: DatasetAdapter,
  workspace: string,
  startId: string,
): Promise<Set<string>> {
  const visited = new Set<string>();
  let cursor: string | null = startId;
  while (cursor !== null) {
    if (visited.has(cursor)) failPublication("integrity_failure", "");
    visited.add(cursor);
    if (visited.size > MAX_CHAIN_WALK) failPublication("limit_exceeded", "");
    const row = await contextOne(
      adapter,
      SUPERSEDE_LOG,
      `workspace_name = ${quote(workspace)} AND old_id = ${quote(cursor)}`,
    );
    if (row === null) break;
    const encoded = encodeSupersedeLogRow(row);
    cursor = encoded.new_id as string | null;
  }
  return visited;
}
