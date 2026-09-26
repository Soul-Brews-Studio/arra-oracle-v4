/** The two audit-tier listings no other module wraps -- `listMcpCalls` and
 *  `listConnections` -- and the response decoder they share.
 *
 * Split out of `api/overview.ts` so that file can be about COUNTING alone.
 * The two concerns had nothing in common beyond both being new: one shapes
 * numbers for a card, this one mirrors two wire row types and the methods
 * that return them.
 *
 * Both are counted on the overview page. Since R5 (#103/#102) the server
 * answers both from the operations root (ARRA_DATA_DIR) that the call log and
 * the connection fold write to, so the counts move with MCP traffic; before
 * that they read a dataset nothing wrote to and stayed 0. A page may also
 * carry `unreadable: [{id, reason}]` -- stored rows the server could not
 * encode and withheld rather than fail the page. `toPage` ignores it: a
 * count needs only `total`, which still includes them.
 */
import { type ApiResult, callMethod } from "./client";
import { type Page } from "./listing";
import { type Bank, asError } from "./memory";

/** `context.encodeMcpCallRow.ts` MCP_CALL_FIELDS, in wire order. `duration_ms`
 *  is Int64 decimal TEXT; `created_at` is ISO, derived server-side from raw
 *  epoch MILLIS -- the one column here stored in millis rather than micros. */
export type McpCallRow = {
  id: string; workspace_name: string; session_name: string | null; peer_name: string | null;
  tool: string; status: string; duration_ms: string; h_metadata: string | null;
  internal_metadata: string | null; created_at: string; connection_id: string | null;
  principal: string | null;
};

/** `context.encodeConnectionRow.ts` CONNECTION_FIELDS. `requests`/`tool_calls`
 *  are Int64 decimal TEXT for the same reason `total` is. */
export type ConnectionRow = {
  id: string; workspace_name: string; method: string; principal: string; label: string;
  user_agent: string | null; remote_ip: string | null; first_seen: string; last_seen: string;
  requests: string; tool_calls: string; last_tool: string | null;
};

/** A deliberate second copy of `listing.ts`'s private decoder rather than an
 *  export added over there -- that file belongs to another worktree this week,
 *  and a conflict in it would block two people instead of none. The rule it
 *  encodes is documented once, at `listing.ts`'s `isUnsupported`: from a
 *  LISTING route, `method_not_found` or a bare 404 means the method is absent,
 *  because a listing has no row identity that could legitimately be missing.
 *
 * Note what a failed request looks like coming out of here: empty rows, null
 * cursor, null total. The null CURSOR is why nothing downstream may read
 * `nextCursor === null` as "that was the whole set" -- see `countWithSample`,
 * which learned that the hard way. */
export function toPage<T>(result: ApiResult, cursorKey: string): Page<T> {
  if (!result.ok) {
    const absent = asError(result.body)?.code === "method_not_found" || result.status === 404;
    return { rows: [], nextCursor: null, total: null, supported: !absent };
  }
  const body = result.body as Record<string, unknown>;
  return {
    rows: Array.isArray(body.rows) ? (body.rows as T[]) : [],
    nextCursor: typeof body[cursorKey] === "string" ? (body[cursorKey] as string) : null,
    total: typeof body.total === "string" ? body.total : null,
    supported: true,
  };
}

/** Both methods send EVERY key, `null` where there is no filter: the grammar is
 *  closed, so an omitted key is `missing_field`, not a default. `tool`/`status`
 *  null means "no filter", never "match null" -- neither is ever null on a row. */
export async function listMcpCalls(
  b: Bank, afterId: string | null, limit: number, includeTotal: boolean,
  tool: string | null, status: string | null,
): Promise<Page<McpCallRow>> {
  const body = { workspace_name: b.workspace, after_id: afterId, limit, tool, status, include_total: includeTotal };
  return toPage<McpCallRow>(await callMethod(b.bank, "listMcpCalls", body, b.token), "next_after_id");
}

export async function listConnections(
  b: Bank, afterId: string | null, limit: number, includeTotal: boolean,
): Promise<Page<ConnectionRow>> {
  const body = { workspace_name: b.workspace, after_id: afterId, limit, include_total: includeTotal };
  return toPage<ConnectionRow>(await callMethod(b.bank, "listConnections", body, b.token), "next_after_id");
}
