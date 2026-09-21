import { failTaxonomy } from "./taxonomy.failTaxonomy";

export function storedNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") failTaxonomy("integrity_failure");
  return value;
}
