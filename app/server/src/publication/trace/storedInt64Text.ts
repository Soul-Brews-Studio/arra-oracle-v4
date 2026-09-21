import { failPublication } from "../errors";
import { toInt64Text } from "../rows";

/** RAW int64 (bigint or safe-integer number) to canonical decimal TEXT.
 *  Delegates the range bound to the accepted `./rows.toInt64Text`, which
 *  refuses anything outside signed 64-bit range -- this module must not
 *  silently accept a value that could never have round-tripped through the
 *  physical Int64 column it was read from. */
export function storedInt64Text(value: unknown): string {
  if (typeof value === "bigint") return toInt64Text(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return toInt64Text(BigInt(value));
  }
  return failPublication("integrity_failure", "");
}
