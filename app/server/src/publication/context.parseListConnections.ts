import { requireBoolean, requireClosedObject, requireNullableNonemptyString } from "../contracts/common";
import { fail } from "../contracts/errors";
import { name } from "./context.name";
import { parseRequest } from "./context.parseRequest";

/** Page size ceiling for listConnections, matching listMcpCalls: both are
 *  audit-tier projections, not chat-volume messages. */
export const MAX_PAGE_LIMIT = 200;

export type ListConnectionsRequest = {
  workspace_name: string;
  after_id: string | null;
  limit: number;
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
export function parseListConnections(bytes: Uint8Array): ListConnectionsRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "after_id", "limit", "include_total"], []);
  const rawLimit = o.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    // `connections.id` is utf8, not Int64 -- the cursor is the exact stored
    // `id` text, not a decimal.
    after_id: requireNullableNonemptyString(o.get("after_id") ?? null, ["after_id"]),
    limit: rawLimit,
    include_total: requireBoolean(o.get("include_total") ?? null, ["include_total"]),
  };
}
