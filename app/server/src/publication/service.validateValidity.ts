import { failPublication } from "./errors";
import { timestampToMicros } from "./rows";

/** Validity interval, checked only when BOTH bounds are present. */
export function validateValidity(encoded: Record<string, unknown>): void {
  const from = encoded.valid_from;
  const to = encoded.valid_to;
  if (typeof from !== "string" || typeof to !== "string") return;
  if (timestampToMicros(from) >= timestampToMicros(to)) {
    failPublication("invalid_request", "/content/valid_from");
  }
}
