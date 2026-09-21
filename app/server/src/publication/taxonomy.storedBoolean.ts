import { failTaxonomy } from "./taxonomy.failTaxonomy";

export function storedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") failTaxonomy("integrity_failure");
  return value;
}
