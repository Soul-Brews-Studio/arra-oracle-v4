import { type TaxonomyRow } from "./service.types";

/**
 * Compare a stored row against the state we would have written.
 *
 * `created_at` is EXCLUDED: an existing row keeps its own validated allocation
 * time, and a retry must never refresh it. Everything else must match exactly,
 * so a renamed or retired row conflicts rather than being silently repaired.
 */
export function sameExcept(stored: TaxonomyRow, expected: TaxonomyRow, fields: readonly string[]): boolean {
  for (const field of fields) {
    if (field === "created_at") continue;
    if (stored[field] !== expected[field]) return false;
  }
  return true;
}
