import { sha256HexWithDomain } from "../contracts/common";
import { canonicalize, obj } from "../contracts/jcs";

/**
 * Versioned domain separator for the Relic capture digest -- same pattern as
 * `contracts/evidence-v1.ts`'s `TARGET_DOMAIN`, a DIFFERENT domain because
 * this hashes a different, narrower payload (a single retrieved event, not a
 * whole normalized target).
 */
export const RELIC_CAPTURE_DOMAIN = "arra-relic-capture/v1\n";

/**
 * DESIGN.md: "Hash a versioned canonical source payload (speaker/content/
 * source time), excluding ingestion time." Exactly those three fields, JCS
 * canonicalized, sha256-hashed under `RELIC_CAPTURE_DOMAIN` -- deliberately
 * excludes `eventSeq`/`transcriptRef` (identity, not content) and any local
 * "when we fetched this" timestamp (ingestion time), so two fetches of the
 * SAME source content always produce the SAME digest, and any change to
 * what was said, who said it, or when it was originally said produces a
 * DIFFERENT one.
 */
export function captureDigest(speaker: string, content: string, sourceTime: string): string {
  const payload = obj({ speaker, content, source_time: sourceTime });
  return sha256HexWithDomain(RELIC_CAPTURE_DOMAIN, canonicalize(payload, []));
}
