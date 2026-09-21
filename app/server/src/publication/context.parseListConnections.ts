import { requireClosedObject, requireNullableNonemptyString } from "../contracts/common";
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
};

export function parseListConnections(bytes: Uint8Array): ListConnectionsRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "after_id", "limit"], []);
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
  };
}
