import { requireExactColumns } from "./trace.requireExactColumns";
import { storedNanoid } from "./trace.storedNanoid";
import { storedNonemptyText } from "./trace.storedNonemptyText";
import { storedNullableNonemptyText } from "./trace.storedNullableNonemptyText";
import { storedNullableMillisTimestamp } from "./trace.storedNullableMillisTimestamp";
import { storedFloat64OrNull } from "./trace.storedFloat64OrNull";
import { storedNullableNanoid } from "./trace.storedNullableNanoid";
import { storedNonNegativeInt64Text } from "./trace.storedNonNegativeInt64Text";
import { storedStatus } from "./trace.storedStatus";
import { storedNullableText } from "./trace.storedNullableText";
import { storedMillisTimestamp } from "./trace.storedMillisTimestamp";

/** The exact physical field order of a stored `traces` row. */
export const TRACE_FIELDS = [
  "id",
  "name",
  "workspace_name",
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
  "created_at",
  "updated_at",
] as const;

/** One stored `traces` row to its exact 20 wire fields, in physical order. */
export function encodeTraceRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, TRACE_FIELDS);
  return {
    id: storedNanoid(row.id),
    name: storedNonemptyText(row.name),
    workspace_name: storedNonemptyText(row.workspace_name),
    session_name: storedNullableNonemptyText(row.session_name),
    peer_name: storedNullableNonemptyText(row.peer_name),
    query: storedNonemptyText(row.query),
    // Nullable but NOT non-empty: the request grammar's `nullableShortText`
    // requires nonempty when present, so these three CAN'T legitimately
    // differ -- tightened to match TR-11.
    mode: storedNullableNonemptyText(row.mode),
    session_id: storedNullableNonemptyText(row.session_id),
    // Raw MILLISECONDS. NOT the ./rows micros helper -- see file header.
    session_from_ts: storedNullableMillisTimestamp(row.session_from_ts),
    session_to_ts: storedNullableMillisTimestamp(row.session_to_ts),
    friction_score: storedFloat64OrNull(row.friction_score),
    confidence: storedNullableNonemptyText(row.confidence),
    parent_id: storedNullableNanoid(row.parent_id),
    prev_id: storedNullableNanoid(row.prev_id),
    depth: storedNonNegativeInt64Text(row.depth),
    status: storedStatus(row.status),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    // Raw MILLISECONDS, required. Immutability (`updated_at === created_at`
    // on a FRESH write) is asserted by the caller on readback, not here: an
    // imported legacy row may legitimately differ, and this codec has no way
    // to distinguish "just created" from "imported" by row shape alone.
    created_at: storedMillisTimestamp(row.created_at),
    updated_at: storedMillisTimestamp(row.updated_at),
  };
}
