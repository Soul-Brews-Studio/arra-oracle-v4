import { obj } from "../contracts/jcs";
import { normalizeTarget } from "../contracts/evidence-v1";
import type { SessionRef } from "./session-source.types";

/** The exact `relic_session` target shape (`contracts/evidence-v1.ts`
 *  `TARGET_KEYS.relic_session`), plain JSON-serializable. */
export type RelicSessionTarget = {
  source_bank: string;
  provider: string;
  session_uuid: string;
  title_snapshot: string | null;
};

/**
 * Build a codec-VALID `relic_session` evidence target from an already
 * resolved `SessionRef` -- for citing a WHOLE session (`session_id` on a
 * `traces` row, or a session-link `evidence_ref`), as opposed to
 * `buildRelicEventTarget`'s single pinned event. `title_snapshot` is
 * DISPLAY-ONLY (`evidence-v1.ts` `DISPLAY_ONLY.relic_session`): it is never
 * part of this target's identity, so a session's title changing later never
 * changes which stored target this equals.
 */
export function buildRelicSessionTarget(session: SessionRef): RelicSessionTarget {
  const raw = obj({
    source_bank: session.sourceBank,
    provider: session.provider,
    session_uuid: session.sessionUuid,
    title_snapshot: session.title,
  });
  const normalized = normalizeTarget("relic_session", raw, []);
  return Object.fromEntries(normalized) as RelicSessionTarget;
}
