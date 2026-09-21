import { timestampToMicros } from "./rows";

/**
 * Wire row -> PHYSICAL row for the shared Arrow append.
 *
 * The derived rows are WIRE shaped: `position` is decimal text and
 * `captured_at` is an exact millisecond string. The shared append builds Arrow
 * from BigInt and timestamp columns, so handing it the wire shapes writes the
 * wrong physical types. Converted here rather than in storage.ts, which stays
 * protected.
 */
export function physicalDerivedRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  out.position = BigInt(row.position as string);
  if ("captured_at" in row) {
    out.captured_at = row.captured_at === null ? null : timestampToMicros(row.captured_at as string);
  }
  return out;
}
