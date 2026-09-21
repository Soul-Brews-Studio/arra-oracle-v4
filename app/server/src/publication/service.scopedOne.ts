import { failTaxonomy } from "./taxonomy";
import { type DatasetAdapter } from "./service.types";

/** Exactly one row at a scoped identity, or null. Never a first-match guess. */
export async function scopedOne(
  adapter: DatasetAdapter,
  table: string,
  predicate: string,
): Promise<Record<string, unknown> | null> {
  const rows = await adapter.query(table, predicate);
  if (rows.length === 0) return null;
  // Multiple rows at an identity that must be unique is corruption. Picking
  // one would make a corrupt dataset look healthy.
  //
  // ROOT path, deliberately: this is a global stored-state failure, not a
  // complaint about the field the caller happened to send.
  if (rows.length > 1) failTaxonomy("integrity_failure", "");
  return rows[0]!;
}
