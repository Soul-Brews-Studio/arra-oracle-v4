import { hasOnlyPairedSurrogates } from "../../contracts/jcs";
import { failPublication } from "../errors";

/** Optional JSON column: retained BYTE-FOR-BYTE. This slice does not parse or
 *  recanonicalize its contents. */
export function storedNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") failPublication("integrity_failure");
  // EMPTY is a legitimate retained value; a lone surrogate is not. This slice
  // does not parse the JSON contents, only require the string be well formed.
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure");
  return value;
}
