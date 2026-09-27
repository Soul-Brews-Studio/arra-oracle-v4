import { requireClosedObject, requireNonNegativeInt64String } from "../contracts/common";
import { fail } from "../contracts/errors";
import { HISTORY_KEYS, MAX_HISTORY_LIMIT, type ListLifecycleHistoryRequest } from "./lifecycle.constants";
import { name } from "./lifecycle.name";
import { nodeId } from "./lifecycle.nodeId";
import { parseRequest } from "./lifecycle.parseRequest";

export function parseListLifecycleHistory(bytes: Uint8Array): ListLifecycleHistoryRequest {
  const request = requireClosedObject(parseRequest(bytes), HISTORY_KEYS, []);
  const rawLimit = request.get("limit");
  // A small JSON integer, deliberately: the page size is not an Int64 wire
  // field, so a decimal string here is a type error rather than a cursor.
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_HISTORY_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_HISTORY_LIMIT}`);
  }
  const rawAfter = request.get("after_event_id");
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    node_id: nodeId(request.get("node_id"), ["node_id"]),
    // `supersede_log.id` is only ever allocated >= 1 (service.ts's max+1
    // allocator), so a negative cursor is a caller error, not a valid "start
    // from the beginning" -- delegate to the accepted non-negative grammar
    // rather than a local reimplementation.
    after_event_id:
      rawAfter === null ? null : requireNonNegativeInt64String(rawAfter ?? null, ["after_event_id"]).text,
    limit: rawLimit,
  };
}
