import { fail } from "../contracts/errors";
import { requireClosedObject, requireNanoid21 } from "../contracts/common";
import { parseRequest } from "./trace.parseRequest";
import { name } from "./trace.name";
import { nullableInt64Text } from "./trace.nullableInt64Text";
import type { ListTraceHitsRequest } from "./trace.types";

/** Page size ceiling for listTraceHits. A small JSON integer, NOT an Int64. */
export const MAX_PAGE_LIMIT = 200;

const LIST_TRACE_HITS_KEYS = ["workspace_name", "trace_id", "after_position", "limit"] as const;

export function parseListTraceHits(bytes: Uint8Array): ListTraceHitsRequest {
  const request = requireClosedObject(parseRequest(bytes), LIST_TRACE_HITS_KEYS, []);
  const rawLimit = request.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("out_of_range", ["limit"], `limit must be an integer in [1, ${MAX_PAGE_LIMIT}]`);
  }
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    trace_id: requireNanoid21(request.get("trace_id") ?? null, ["trace_id"]),
    after_position: nullableInt64Text(request.get("after_position"), ["after_position"]),
    limit: rawLimit,
  };
}
