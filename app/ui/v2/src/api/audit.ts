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

// Functions split out (style-ui-split, docs/overnight/DECISIONS.md): each
// lives in its own file named after itself, re-exported here so importers
// (`state/useOverview.ts`) do not churn.
export { toPage } from "./audit.toPage";
export { listMcpCalls } from "./audit.listMcpCalls";
export { listConnections } from "./audit.listConnections";
