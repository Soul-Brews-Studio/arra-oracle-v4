import { requireClosedObject, requireNullableNonemptyString } from "../contracts/common";
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
};

export function parseListMcpCalls(bytes: Uint8Array): ListMcpCallsRequest {
  const o = requireClosedObject(
    parseRequest(bytes),
    ["workspace_name", "after_id", "limit", "tool", "status"],
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
  };
}
