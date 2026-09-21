import { failPublication } from "./errors";

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Exact signed Int64 as canonical decimal TEXT. Never via Number. */
export function storedInt64(value: unknown, opts: { min?: bigint } = {}): string {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure");
    parsed = BigInt(value);
  } else return failPublication("integrity_failure");
  if (parsed < INT64_MIN || parsed > INT64_MAX) failPublication("integrity_failure");
  if (opts.min !== undefined && parsed < opts.min) failPublication("integrity_failure");
  return parsed.toString(10);
}
