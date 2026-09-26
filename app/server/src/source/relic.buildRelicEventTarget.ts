import { obj } from "../contracts/jcs";
import { normalizeTarget } from "../contracts/evidence-v1";
import { captureDigest } from "./relic.captureDigest";
import type { SourceExcerpt, SessionRef } from "./session-source.types";

/** The exact `relic_event` target shape (`contracts/evidence-v1.ts`
 *  `TARGET_KEYS.relic_event`), as a plain JSON-serializable object -- ready
 *  to hand to `createTrace`'s `hits[].target` or `createSessionLink`'s
 *  `evidence_ref.target` over the existing HTTP/MCP transport. */
export type RelicEventTarget = {
  source_bank: string;
  provider: string;
  session_uuid: string;
  transcript_ref: string;
  event_seq: string;
  capture_digest: string;
};

/**
 * Build a codec-VALID `relic_event` evidence target from one already-fetched
 * `SourceExcerpt`, for use in `createTrace` hits and `createSessionLink`'s
 * `evidence_ref` (analysis-28.json Unit D item 3). Pure: no dataset, no
 * subprocess -- the excerpt must already have come from `SessionSource.find`
 * /`read`.
 *
 * Runs the result through the SAME `normalizeTarget("relic_event", …)` the
 * server applies at write time, so a malformed excerpt (e.g. a negative
 * `eventSeq`, which the codec's `requireNonNegativeInt64String` refuses)
 * fails HERE, at build time, with the exact `ContractError` the server would
 * also raise -- never a target that looks valid until it reaches a real
 * `createTrace` call.
 */
export function buildRelicEventTarget(session: SessionRef, excerpt: SourceExcerpt): RelicEventTarget {
  const digest = captureDigest(excerpt.speaker, excerpt.content, excerpt.sourceTime);
  const raw = obj({
    source_bank: session.sourceBank,
    provider: session.provider,
    session_uuid: session.sessionUuid,
    transcript_ref: excerpt.transcriptRef,
    event_seq: String(excerpt.eventSeq),
    capture_digest: digest,
  });
  const normalized = normalizeTarget("relic_event", raw, []);
  return Object.fromEntries(normalized) as RelicEventTarget;
}
