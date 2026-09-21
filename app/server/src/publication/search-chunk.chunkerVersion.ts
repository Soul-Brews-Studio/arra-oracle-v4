import type { Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import type { JcsValue } from "../contracts/jcs";
import { name } from "./search-chunk.name";

/** The one deterministic chunker this slice implements. */
export const CHUNKER_VERSION = "chunker/v1";

/**
 * The ONLY implemented chunker label. `chunker_version` is not free text: it
 * is a content-derived identity input (it keys both the chunk id and the
 * idempotency check), so an unvalidated string here would let a caller label
 * v1 output as `"chunker/v2"` -- a real v2 implementation would later derive
 * the SAME ids for that label and treat the v1 rows as already_satisfied,
 * forever. Rejecting anything but the one constant this module actually runs
 * keeps the label and the code that produced it in agreement.
 */
export function chunkerVersion(value: JcsValue | undefined, tokens: Tokens): string {
  const text = name(value, tokens);
  if (text !== CHUNKER_VERSION) {
    fail("invalid_value", tokens, `expected ${JSON.stringify(CHUNKER_VERSION)}`);
  }
  return text;
}
