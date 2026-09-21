import { failPublication } from "./errors";

/** Int64 physical column: decimal TEXT on the wire, matching `rows.ts`. */
export function storedInt64Text(value: unknown): string {
  const asBigInt =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : failPublication("integrity_failure", "");
  if (asBigInt < -(2n ** 63n) || asBigInt > 2n ** 63n - 1n) failPublication("integrity_failure", "");
  return asBigInt.toString(10);
}
