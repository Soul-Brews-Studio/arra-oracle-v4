import { type JcsObject } from "../contracts/jcs";
import { type RevisionResult, ENVELOPE_KEYS } from "../contracts/revision-v1";

/**
 * The validated envelope as a flat encoded record, for reference checks.
 *
 * Uses the codec's NORMALIZED JSON columns rather than the raw request
 * strings, so the checks run against exactly what will be persisted.
 */
export function encodeEnvelopeForChecks(
  validated: RevisionResult,
  envelope: JcsObject,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) out[key] = envelope.get(key) ?? null;
  const columns = validated.columns as unknown as Record<string, unknown>;
  for (const key of ["fields", "term_snapshot_json", "link_snapshot_json", "h_metadata", "internal_metadata"]) {
    out[key] = columns[key] ?? null;
  }
  return out;
}
