import { timingSafeEqual } from "node:crypto";
import type { CredentialRecord } from "./policy.types";

/**
 * Compare the presented digest against every credential digest with a
 * fixed-length timing-safe primitive, without early exit.
 *
 * Only this comparison loop is timing-safe; no claim is made about the whole
 * request, the parser, or policy lookup generally.
 */
export function findCredential(
  credentials: readonly CredentialRecord[],
  presented: Buffer,
): CredentialRecord | null {
  let match: CredentialRecord | null = null;
  let matches = 0;
  for (const credential of credentials) {
    // Both operands are exactly 32 bytes: the stored hex is validated as 64
    // lowercase hex at parse time, and `presented` is a SHA-256 output.
    if (timingSafeEqual(Buffer.from(credential.digestHex, "hex"), presented)) {
      match = credential;
      matches += 1;
    }
  }
  // Parsing rejects duplicate digests, so more than one match cannot happen;
  // if it somehow did, admitting an ambiguous credential would be worse.
  return matches === 1 ? match : null;
}
