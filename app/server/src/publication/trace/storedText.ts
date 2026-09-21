import { failPublication } from "../errors";
import { hasOnlyPairedSurrogates } from "../../contracts/jcs";

export function storedText(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure", "");
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure", "");
  return value;
}
