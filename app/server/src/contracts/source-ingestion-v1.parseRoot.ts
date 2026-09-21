import { fail } from "../errors";
import { LIMITS, parseStrict, type JcsValue } from "../jcs";

/** Parse one bounded root document with the accepted strict rules. */
export function parseRoot(json: unknown): JcsValue {
  if (typeof json !== "string") fail("invalid_type", [], "expected a raw JSON string");
  return parseStrict(json, [], { maxBytes: LIMITS.maxDocumentBytes, maxDepth: LIMITS.maxDepth });
}
