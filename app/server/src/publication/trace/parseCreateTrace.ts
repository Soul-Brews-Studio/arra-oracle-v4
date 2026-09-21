import { requireBoundedText, requireClosedObject, requireEnum, requireNanoid21, requireNonemptyString, requireNonNegativeInt64String } from "../../contracts/common";
import { fail } from "../../contracts/errors";
import { parseRequest } from "./parseRequest";
import { name } from "./name";
import { nullableShortText } from "./nullableShortText";
import { nullableTimestamp } from "./nullableTimestamp";
import { nullableFriction } from "./nullableFriction";
import { nullablePointer } from "./nullablePointer";
import { nullableOpaqueText } from "./nullableOpaqueText";
import { parseHit } from "./parseHit";
import { MAX_SHORT_TEXT_BYTES } from "./constants";
import { TRACE_STATUSES, type CreateTraceRequest } from "./types";

const MAX_QUERY_BYTES = 8192;

/** Hits per createTrace call. Nonempty is NOT required: a trace may start
 *  with zero hits and gain none later, since hits are immutable and there is
 *  no append-hits method in v1. */
export const MAX_HITS = 256;

const CREATE_TRACE_KEYS = [
  "workspace_name",
  "id",
  "name",
  "session_name",
  "peer_name",
  "query",
  "mode",
  "session_id",
  "session_from_ts",
  "session_to_ts",
  "friction_score",
  "confidence",
  "parent_id",
  "prev_id",
  "depth",
  "status",
  "h_metadata",
  "internal_metadata",
  "hits",
] as const;

export function parseCreateTrace(bytes: Uint8Array): CreateTraceRequest {
  const request = requireClosedObject(parseRequest(bytes), CREATE_TRACE_KEYS, []);
  const rawHits = request.get("hits");
  if (!Array.isArray(rawHits)) fail("invalid_type", ["hits"], "expected array");
  if (rawHits.length > MAX_HITS) fail("limit_exceeded", ["hits"], `at most ${MAX_HITS} hits`);
  const hits = rawHits.map((h, i) => parseHit(h, ["hits", i]));
  // Contiguous 0..n-1 is an INVARIANT of "position = array index" (assigned
  // by `service.ts` from this array's own order), documentation only: an
  // Array#map index can never fall outside [0, length), so there is no
  // runtime branch to write here that could ever fire. The enforcement this
  // invariant actually needs is on the READ side, where a stored position
  // did not come from this construction -- see `listTraceHits` and the
  // replay comparison in `createTrace` (service.ts).

  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    id: requireNanoid21(request.get("id") ?? null, ["id"]),
    name: requireBoundedText(
      requireNonemptyString(request.get("name") ?? null, ["name"]),
      MAX_SHORT_TEXT_BYTES,
      ["name"],
    ),
    session_name: nullableShortText(request.get("session_name"), ["session_name"]),
    peer_name: nullableShortText(request.get("peer_name"), ["peer_name"]),
    query: requireBoundedText(requireNonemptyString(request.get("query") ?? null, ["query"]), MAX_QUERY_BYTES, [
      "query",
    ]),
    mode: nullableShortText(request.get("mode"), ["mode"]),
    session_id: nullableShortText(request.get("session_id"), ["session_id"]),
    session_from_ts: nullableTimestamp(request.get("session_from_ts"), ["session_from_ts"]),
    session_to_ts: nullableTimestamp(request.get("session_to_ts"), ["session_to_ts"]),
    friction_score: nullableFriction(request.get("friction_score"), ["friction_score"]),
    confidence: nullableShortText(request.get("confidence"), ["confidence"]),
    parent_id: nullablePointer(request.get("parent_id"), ["parent_id"]),
    prev_id: nullablePointer(request.get("prev_id"), ["prev_id"]),
    depth: requireNonNegativeInt64String(request.get("depth") ?? null, ["depth"]).text,
    status: requireEnum(request.get("status") ?? null, TRACE_STATUSES, ["status"]),
    h_metadata: nullableOpaqueText(request.get("h_metadata"), ["h_metadata"]),
    internal_metadata: nullableOpaqueText(request.get("internal_metadata"), ["internal_metadata"]),
    hits,
  };
}
