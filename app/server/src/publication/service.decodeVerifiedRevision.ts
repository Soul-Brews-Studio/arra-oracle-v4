import { ENVELOPE_KEYS, verifyRevisionOp } from "../contracts/revision-v1";
import { failPublication } from "./errors";
import { encodeRevisionRow } from "./rows";
import { type RevisionRow } from "./service.types";

/**
 * Encode a stored revision AND prove its canonical bytes still match.
 *
 * Encoding alone accepts whatever is on disk. A row whose body was edited
 * while its `content_digest` stayed put would pass every shape check and be
 * served as accepted history -- which is exactly the hole this closes. The
 * digest is RECOMPUTED from the stored columns and compared, so tampering
 * fails as integrity rather than being trusted because the string looks
 * plausible.
 */
export function decodeVerifiedRevision(row: RevisionRow): Record<string, unknown> {
  const encoded = encodeRevisionRow(row);
  const envelope = new Map<string, unknown>();
  for (const key of ENVELOPE_KEYS) envelope.set(key, encoded[key] ?? null);
  try {
    verifyRevisionOp(envelope as never, encoded.content_digest as never, []);
  } catch {
    // Any recompute failure is stored-state corruption, never a request fault.
    failPublication("integrity_failure");
  }
  return encoded;
}
