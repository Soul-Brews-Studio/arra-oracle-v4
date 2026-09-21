import { requireBoolean, requireClosedObject, requireNullableNonemptyString } from "../contracts/common";
import { fail } from "../contracts/errors";
import { name } from "./context.name";
import { parseRequest } from "./context.parseRequest";

/** Page size ceiling for listMcpCalls, matching listTraceHits: an audit/call
 *  log is higher volume than a chat session, so it takes the wider of the
 *  two existing ceilings rather than the narrower `listMessages` one. */
export const MAX_PAGE_LIMIT = 200;

export type ListMcpCallsRequest = {
  workspace_name: string;
  after_id: string | null;
  limit: number;
  /** null means "no filter", not "match null" -- this table's `tool`/`status`
   *  columns are never null on a stored row. */
  tool: string | null;
  status: string | null;
  include_total: boolean;
};

/** `include_total` is on EVERY listing method, including the two that have no
 *  obvious need for it.
 *
 *  It was added to listPeers/listSessions/listNodes and omitted here, which
 *  meant a client could not write one pager for all five: three methods
 *  refused a request without the key, and two refused the same request WITH
 *  it, as `unexpected_field`. The isolation proof found this by trying
 *  exactly that -- one generic walk across all five specs.
 *
 *  A closed grammar makes uniformity cheap to state and expensive to skip:
 *  there is no default to fall back on, so every difference between two
 *  otherwise-identical methods becomes a special case in every caller. */
export function parseListMcpCalls(bytes: Uint8Array): ListMcpCallsRequest {
  const o = requireClosedObject(
    parseRequest(bytes),
    ["workspace_name", "after_id", "limit", "tool", "status", "include_total"],
    [],
  );
  const rawLimit = o.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    // `mcp_calls.id` is utf8 (`c_<base36ms>_<random6>`), not Int64 -- the
    // cursor is the exact stored `id` text, not a decimal.
    after_id: requireNullableNonemptyString(o.get("after_id") ?? null, ["after_id"]),
    limit: rawLimit,
    tool: requireNullableNonemptyString(o.get("tool") ?? null, ["tool"]),
    status: requireNullableNonemptyString(o.get("status") ?? null, ["status"]),
    include_total: requireBoolean(o.get("include_total") ?? null, ["include_total"]),
  };
}
