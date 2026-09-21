import { failPublication } from "./errors";

/**
 * EXACTLY these columns: present, own, and nothing else. Copied from
 * `read-cursor.ts` rather than imported, because a shared helper reaching
 * across two independent row shapes is how one slice's column list quietly
 * becomes the other's.
 */
export function requireExactColumns(row: unknown, fields: readonly string[]): Record<string, unknown> {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    failPublication("integrity_failure", "");
  }
  const actual = Object.keys(row as Record<string, unknown>);
  if (actual.length !== fields.length) failPublication("integrity_failure", "");
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      failPublication("integrity_failure", "");
    }
  }
  return row as Record<string, unknown>;
}
