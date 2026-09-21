import { failPublication } from "./errors";

export function rawMicrosOf(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return BigInt(value);
  }
  return failPublication("integrity_failure", "");
}
