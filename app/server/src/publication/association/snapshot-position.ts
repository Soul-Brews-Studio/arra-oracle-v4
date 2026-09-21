import { failPublication } from "../errors";

const INT64_MAX = 2n ** 63n - 1n;

/** Canonical nonnegative Int64 decimal text, from a snapshot entry. */
export function snapshotPosition(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure");
  if (value === "-0" || !/^(0|[1-9][0-9]*)$/.test(value)) failPublication("integrity_failure");
  if (BigInt(value) > INT64_MAX) failPublication("integrity_failure");
  return value;
}
