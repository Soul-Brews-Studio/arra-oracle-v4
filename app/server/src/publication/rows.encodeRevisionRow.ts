import { failPublication } from "./errors";
import { rawMicros } from "./rows.rawMicros";
import { requireNullableString } from "./rows.requireNullableString";
import { requireString } from "./rows.requireString";
import { toInt64Text } from "./rows.toInt64Text";
import { microsToTimestamp } from "./rows.microsToTimestamp";
import { INT64_REVISION_FIELDS, REVISION_FIELDS, TIMESTAMP_REVISION_FIELDS } from "./rows.constants";

/**
 * Encode one physical NodeRevision row for the wire.
 *
 * Exactly the 26 closed fields, in target physical-schema order. The five
 * JSON-valued columns stay as their stored canonical STRINGS -- re-parsing
 * them into nested objects would invent a shape the contract does not define
 * and would risk re-serialising different bytes than were digested.
 */
export function encodeRevisionRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of REVISION_FIELDS) {
    const value = row[field];
    if (INT64_REVISION_FIELDS.has(field)) {
      const asBigInt =
        typeof value === "bigint"
          ? value
          : typeof value === "number" && Number.isSafeInteger(value)
            ? BigInt(value)
            : failPublication("integrity_failure");
      out[field] = toInt64Text(asBigInt);
      continue;
    }
    if (TIMESTAMP_REVISION_FIELDS.has(field)) {
      if (value === null || value === undefined) {
        // created_at is NOT nullable in the physical schema.
        if (field === "created_at") failPublication("integrity_failure");
        out[field] = null;
        continue;
      }
      out[field] = microsToTimestamp(rawMicros(value));
      continue;
    }
    if (field === "is_active") {
      if (typeof value !== "boolean") failPublication("integrity_failure");
      out[field] = value;
      continue;
    }
    // Required text columns vs nullable ones.
    out[field] =
      field === "base_revision_id" ||
      field === "author_peer_name" ||
      field === "observer_peer_name" ||
      field === "subject_peer_name" ||
      field === "session_name" ||
      field === "change_reason" ||
      field === "h_metadata" ||
      field === "internal_metadata"
        ? requireNullableString(value)
        : requireString(value);
  }
  return out;
}
