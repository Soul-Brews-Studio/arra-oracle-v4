import { requireExactColumns } from "./requireExactColumns";
import { storedNonemptyText } from "./storedNonemptyText";
import { storedNanoid } from "./storedNanoid";
import { storedTargetKind } from "./storedTargetKind";
import { storedNullableInt64Text } from "./storedNullableInt64Text";
import { storedNullableNonemptyText } from "./storedNullableNonemptyText";
import { storedMicrosTimestampOrNull } from "./storedMicrosTimestampOrNull";
import { storedNonNegativeInt64Text } from "./storedNonNegativeInt64Text";

/** The exact physical field order of a stored `trace_hits` row. There is NO
 *  `id` column: the only key is (workspace_name, trace_id, position). */
export const TRACE_HIT_FIELDS = [
  "workspace_name",
  "trace_id",
  "kind",
  "ref",
  "target",
  "line_start",
  "line_end",
  "excerpt",
  "content_hash",
  "captured_at",
  "note",
  "position",
] as const;

/** One stored `trace_hits` row to its exact 12 wire fields, in physical
 *  order. `target` is passed through as its stored canonical JSON TEXT:
 *  re-parsing it into a nested object here would invent a shape the wire
 *  contract does not define for a read path. */
export function encodeTraceHitRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, TRACE_HIT_FIELDS);
  return {
    workspace_name: storedNonemptyText(row.workspace_name),
    trace_id: storedNanoid(row.trace_id),
    kind: storedTargetKind(row.kind),
    ref: storedNonemptyText(row.ref),
    target: storedNonemptyText(row.target),
    line_start: storedNullableInt64Text(row.line_start),
    line_end: storedNullableInt64Text(row.line_end),
    // Nullable but NOT non-empty (TR-11): the request grammar's
    // `nullableLongText`/`nullableShortText` require nonempty when present,
    // so a stored "" here is state this service could never have written.
    excerpt: storedNullableNonemptyText(row.excerpt),
    content_hash: storedNullableNonemptyText(row.content_hash),
    // Raw MICROSECONDS -- the ONE column in this whole kernel that really is
    // micros. Everything else on the trace row is milliseconds.
    captured_at: storedMicrosTimestampOrNull(row.captured_at),
    note: storedNullableNonemptyText(row.note),
    position: storedNonNegativeInt64Text(row.position),
  };
}
