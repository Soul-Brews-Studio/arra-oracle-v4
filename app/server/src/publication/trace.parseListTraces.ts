import { fail } from "../contracts/errors";
import { requireClosedObject } from "../contracts/common";
import { parseRequest } from "./trace.parseRequest";
import { name } from "./trace.name";
import { nullableInt64Text } from "./trace.nullableInt64Text";
import { nullablePointer } from "./trace.nullablePointer";
import { nullableShortText } from "./trace.nullableShortText";
import { nullableTimestamp } from "./trace.nullableTimestamp";
import type { ListTracesRequest } from "./trace.types";

/** Page size ceiling for listTraces (K5). Declared separately from
 *  `listTraceHits`' MAX_PAGE_LIMIT: the two are unrelated tables, and a
 *  future change to one bound must never silently move the other. */
export const MAX_LIST_TRACES_LIMIT = 100;

const LIST_TRACES_KEYS = [
  "workspace_name",
  "parent_id",
  "prev_id",
  "depth",
  "query_contains",
  "after_created_at",
  "after_id",
  "limit",
] as const;

export function parseListTraces(bytes: Uint8Array): ListTracesRequest {
  const request = requireClosedObject(parseRequest(bytes), LIST_TRACES_KEYS, []);
  const rawLimit = request.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIST_TRACES_LIMIT) {
    fail("out_of_range", ["limit"], `limit must be an integer in [1, ${MAX_LIST_TRACES_LIMIT}]`);
  }
  const after_created_at = nullableTimestamp(request.get("after_created_at"), ["after_created_at"]);
  const after_id = nullablePointer(request.get("after_id"), ["after_id"]);
  // A COMPOUND cursor: `created_at` alone is not a total order (two traces
  // can share a millisecond), so half a cursor is ambiguous rather than
  // merely imprecise -- refused outright, never silently treated as "start".
  if ((after_created_at === null) !== (after_id === null)) {
    fail("invalid_value", ["after_id"], "after_created_at and after_id must be given together");
  }
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    parent_id: nullablePointer(request.get("parent_id"), ["parent_id"]),
    prev_id: nullablePointer(request.get("prev_id"), ["prev_id"]),
    // Same int64 decimal text `createTrace` stores `depth` from; required
    // but nullable, like every other filter key here (K3's idiom).
    depth: nullableInt64Text(request.get("depth"), ["depth"]),
    query_contains: nullableShortText(request.get("query_contains"), ["query_contains"]),
    after_created_at,
    after_id,
    limit: rawLimit,
  };
}
