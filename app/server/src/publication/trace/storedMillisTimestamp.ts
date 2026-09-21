import { failPublication } from "../errors";
import { millisToTimestamp } from "./millisToTimestamp";

/** RAW storage milliseconds (bigint or safe-integer number), required. */
export function storedMillisTimestamp(value: unknown): string {
  if (typeof value === "bigint") return millisToTimestamp(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return millisToTimestamp(BigInt(value));
  }
  return failPublication("integrity_failure", "");
}
