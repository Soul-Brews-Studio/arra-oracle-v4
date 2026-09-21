import { failTaxonomy } from "./taxonomy.failTaxonomy";

export function storedEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) failTaxonomy("integrity_failure");
  return value as T;
}
