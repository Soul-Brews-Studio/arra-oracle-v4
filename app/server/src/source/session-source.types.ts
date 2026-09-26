/**
 * `SessionSource` -- the read-only, pluggable interface an external session
 * index is consulted through (DESIGN.md "Message capture and Relic adapter
 * boundary"; SPEC.md section 14.6, `interface SessionSource`).
 *
 * This module is the interface ONLY: no SDK, no subprocess, no fetch. A
 * concrete provider (Relic, in `relic.*.ts`; a future `session-viewer` or
 * `lanceglass` client) implements it. Nothing here assumes which provider is
 * live -- `resolveSessionSourceConfig` (per-provider) is how the composition
 * root decides that, and unset/unconfigured is a real, expected state (see
 * `SessionSourceStatus`), never an error.
 *
 * Contract: app/docs/contracts/session-source-relic-v1.md.
 */

/**
 * One session as the source index knows it -- identity plus display
 * metadata, never full content. `sourceBank`/`provider`/`sessionUuid` are
 * exactly the `relic_session` target's identity triple
 * (`contracts/evidence-v1.ts` `TARGET_KEYS.relic_session`); this type is
 * provider-agnostic in principle, but its three identity fields are named to
 * match that codec directly, since Relic is the only implementation this
 * dispatch ships.
 */
export type SessionRef = {
  sourceBank: string;
  provider: string;
  sessionUuid: string;
  /** A stable locator to the transcript this session's events come from
   *  (Relic: the `.jsonl` absolute path). Not a network URL, never fetched
   *  by this module -- passed through to `transcript_ref` on a pinned
   *  `relic_event` target. */
  transcriptRef: string;
  /** Display only -- never part of any target's identity (excluded exactly
   *  as `relic_session`'s `title_snapshot` is in `evidence-v1.ts`). */
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

/**
 * One retrieved event, bounded and passive. `speaker`/`content`/`sourceTime`
 * are exactly the three fields DESIGN.md's capture-digest rule hashes
 * ("speaker/content/source time ... excluding ingestion time"); nothing else
 * on this type feeds the digest.
 *
 * `content` is retrieved, UNTRUSTED text: a caller must never interpret it
 * as an instruction, only carry or display it, exactly like a trace hit's
 * `excerpt` (`trace-v1.md` section 6, "passive locators only").
 */
export type SourceExcerpt = {
  eventSeq: number;
  speaker: string;
  content: string;
  sourceTime: string;
  transcriptRef: string;
};

export type ReadOptions = {
  /** Reserved for a future provider with true seq-offset pagination. The
   *  Relic implementation refuses a non-null value today -- see
   *  `relic.readSession.ts` and the contract's "failure modes" section --
   *  rather than silently ignoring a caller's request for a specific
   *  starting point. */
  from?: number | null;
  limit?: number;
};

/**
 * External · pluggable · READ-ONLY. No method here writes, dereferences a
 * network locator, or mutates the source index in any way -- see the
 * contract's "isolation" section for what backs that claim for Relic
 * specifically.
 */
export type SessionSource = {
  find(query: string, limit?: number): Promise<SessionRef[]>;
  get(sessionUuid: string): Promise<SessionRef | null>;
  read(sessionUuid: string, options?: ReadOptions): Promise<SourceExcerpt[]>;
};

/**
 * Explicit degrade state (SPEC.md section 14.6: "Unset => the surface
 * reports 'session source: not configured' ... does not fail, and does not
 * silently return nothing"). A caller composes on `configured` rather than
 * on nullability alone, so "not configured" cannot be confused with "no
 * results".
 */
export type SessionSourceStatus =
  | { configured: false; reason: string }
  | { configured: true; source: SessionSource };
