import { failTaxonomy } from "./fail-taxonomy";

/** Stored-state validator. Same bad value from the STORE is corruption, so
 *  this is integrity_failure, never one of the request-parsing codes. */
export function storedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) failTaxonomy("integrity_failure");
  return value;
}
