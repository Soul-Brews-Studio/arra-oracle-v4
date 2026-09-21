import { hasOnlyPairedSurrogates } from "../../contracts/jcs";
import { failPublication } from "../errors";

/** Nonempty, and genuinely valid Unicode. A lone surrogate is not a string a
 *  caller can round-trip, so it is corruption rather than content. */
export function storedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) failPublication("integrity_failure");
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure");
  return value;
}
