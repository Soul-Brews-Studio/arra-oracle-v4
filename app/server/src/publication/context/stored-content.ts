import { hasOnlyPairedSurrogates } from "../../contracts/jcs";
import { failPublication } from "../errors";

/** Content MAY be empty -- that is the governed grammar -- but it must still
 *  be valid Unicode. A lone surrogate is not a string a caller can round-trip. */
export function storedContent(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure");
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure");
  return value;
}
