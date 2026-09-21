import { LINK_FIELDS as LINK_FIELDS_LOCAL } from "./association";
import { microsToTimestamp } from "./rows";
import { decimalOf } from "./service.decimalOf";
import { rawMicrosOf } from "./service.rawMicrosOf";

export function encodeDerivedLink(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of LINK_FIELDS_LOCAL) {
    if (field === "position") out[field] = decimalOf(row[field]);
    // RAW micros back to the exact wire string, so a stored capture time
    // compares against the derived one instead of always differing.
    else if (field === "captured_at") {
      const raw = row[field];
      out[field] = raw === null || raw === undefined ? null : microsToTimestamp(rawMicrosOf(raw));
    } else out[field] = row[field] ?? null;
  }
  return out;
}
