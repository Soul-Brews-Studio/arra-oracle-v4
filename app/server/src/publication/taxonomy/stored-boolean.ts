import { failTaxonomy } from "./fail-taxonomy";

export function storedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") failTaxonomy("integrity_failure");
  return value;
}
