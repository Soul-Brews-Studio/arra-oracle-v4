import { failPublication } from "./errors";
import { type DatasetAdapter } from "./service.types";

/** Exactly one row at a scoped identity, or null. Never a first-match guess. */
export async function contextOne(
  adapter: DatasetAdapter,
  table: string,
  predicate: string,
): Promise<Record<string, unknown> | null> {
  const rows = await adapter.query(table, predicate, 2);
  if (rows.length === 0) return null;
  // Two rows at an identity that must be unique is corruption. Picking one
  // would make a corrupt dataset look healthy. ROOT path: a global stored-state
  // failure is not a complaint about a caller field.
  if (rows.length > 1) failPublication("integrity_failure", "");
  return rows[0]!;
}
