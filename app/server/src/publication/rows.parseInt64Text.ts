import { failPublication } from "./errors";
import { CANONICAL_INT64, INT64_MAX, INT64_MIN } from "./rows.constants";

export function parseInt64Text(text: unknown): bigint {
  if (typeof text !== "string" || !CANONICAL_INT64.test(text)) failPublication("integrity_failure");
  const parsed = BigInt(text);
  if (parsed < INT64_MIN || parsed > INT64_MAX) failPublication("integrity_failure");
  return parsed;
}
