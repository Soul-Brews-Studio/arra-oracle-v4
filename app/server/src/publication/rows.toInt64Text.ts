import { failPublication } from "./errors";
import { INT64_MAX, INT64_MIN } from "./rows.constants";

export function toInt64Text(value: bigint): string {
  if (value < INT64_MIN || value > INT64_MAX) failPublication("integrity_failure");
  return value.toString(10);
}
