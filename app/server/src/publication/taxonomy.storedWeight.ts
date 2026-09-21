import { failTaxonomy } from "./taxonomy.failTaxonomy";

export function storedWeight(value: unknown): number {
  // Finite number only. This slice creates zero, but an existing non-zero
  // stored value is preserved exactly rather than clamped.
  if (typeof value !== "number" || !Number.isFinite(value)) failTaxonomy("integrity_failure");
  return value;
}
