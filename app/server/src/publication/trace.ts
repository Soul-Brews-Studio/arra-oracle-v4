/**
 * #28 trace + trace_hit kernel -- the PURE half.
 *
 * Request grammar and the stored-row codecs, with no SDK, connection or owner
 * import. Style modelled on `./read-cursor.ts`.
 *
 * =====================================================================
 * CRITICAL UNIT TRAP, stated once here and never assumed elsewhere:
 *
 *   traces.created_at / updated_at / session_from_ts / session_to_ts are raw
 *   int64 MILLISECONDS.
 *   trace_hits.captured_at is timestamp[us], raw MICROSECONDS.
 *
 * The accepted `microsToTimestamp` / `timestampToMicros` helpers in `./rows`
 * are MICROS-ONLY. Reusing them on a `traces` millisecond column would
 * silently mis-scale the value by 1000x. This module therefore defines its
 * OWN millisecond converters (`millisToTimestamp` / `timestampToMillis`)
 * below, and uses the `./rows` micros converters ONLY for `trace_hits.captured_at`.
 * One writer spans two units in one serialized turn -- do not blur them.
 * =====================================================================
 *
 * `trace_hits` is AUTHORITATIVE, not derived: no accepted snapshot contains
 * hits and nothing can rebuild them. This module defines no materializer and
 * no scoped-delete authority over it.
 *
 * Traces and hits are IMMUTABLE in v1: there is no update method here, and
 * none should be added without a fresh review.
 *
 * This file is a thin barrel: one function/type/const per file under
 * `./trace/`, re-exported here so the public surface is unchanged. See
 * `./trace/types.ts` for the request/row shapes and `./trace/constants.ts`
 * for values shared by more than one function.
 */

export { MAX_HITS, parseCreateTrace } from "./trace/parseCreateTrace";
export { parseGetTrace } from "./trace/parseGetTrace";
export { MAX_PAGE_LIMIT, parseListTraceHits } from "./trace/parseListTraceHits";

export { TRACE_STATUSES, type TraceStatus } from "./trace/types";
export type {
  CreateTraceHitInput,
  CreateTraceRequest,
  GetTraceRequest,
  ListTraceHitsRequest,
} from "./trace/types";

export { TRACE_FIELDS, encodeTraceRow } from "./trace/encodeTraceRow";
export { TRACE_HIT_FIELDS, encodeTraceHitRow } from "./trace/encodeTraceHitRow";

export { millisToTimestamp } from "./trace/millisToTimestamp";
export { timestampToMillis } from "./trace/timestampToMillis";
