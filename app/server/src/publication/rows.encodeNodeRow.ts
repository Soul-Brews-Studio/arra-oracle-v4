import { failPublication } from "./errors";
import { rawMicros } from "./rows.rawMicros";
import { requireNullableString } from "./rows.requireNullableString";
import { requireString } from "./rows.requireString";
import { microsToTimestamp } from "./rows.microsToTimestamp";
import { NODE_FIELDS, TIMESTAMP_NODE_FIELDS } from "./rows.constants";

/** Encode one physical Node row: exactly the five columns, in schema order. */
export function encodeNodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of NODE_FIELDS) {
    const value = row[field];
    if (TIMESTAMP_NODE_FIELDS.has(field)) {
      if (value === null || value === undefined) failPublication("integrity_failure");
      out[field] = microsToTimestamp(rawMicros(value));
      continue;
    }
    out[field] = field === "current_revision_id" ? requireNullableString(value) : requireString(value);
  }
  return out;
}
