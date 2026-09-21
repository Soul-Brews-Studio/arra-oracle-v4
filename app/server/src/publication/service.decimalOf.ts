import { failPublication } from "./errors";

export function decimalOf(value: unknown): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return BigInt(value).toString(10);
  }
  if (typeof value === "string") return value;
  return failPublication("integrity_failure", "");
}
