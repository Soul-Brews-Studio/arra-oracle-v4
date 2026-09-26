import { assertNotFlagLike } from "./relic.assertNotFlagLike";
import { failRelic } from "./relic.errors";
import { runRelicJson } from "./relic.runRelicJson";
import { rowToSessionRef } from "./relic.rowToSessionRef";
import type { RelicAdapterConfig, RelicSessionCommandOutput } from "./relic.types";
import type { SessionRef } from "./session-source.types";

/**
 * `SessionSource.get`: `relic session <id> --no-index --json`.
 *
 * `--no-index` is REQUIRED, not optional. Without it, relic's own
 * `resolveSession` (`agents-relic/src/query.ts`) imports a matching on-disk
 * file into the user's REAL relic LanceDB index whenever `id` looks like an
 * id but has no index row yet -- exactly the case for a real, recently
 * started, not-yet-indexed session. `--no-index` skips that fallback; relic
 * still answers from whatever is ALREADY indexed (an id/prefix match, or,
 * failing that, a read-only name match), so an unindexed session is
 * correctly reported as not found here, never silently imported. See the
 * contract's "isolation" section.
 *
 * Only a row whose OWN `session_uuid` equals what was asked for, AND whose
 * `tier` is exactly `"session"`, is trusted. Measured against
 * `agents-relic/src/cli.ts`'s `cmdSession` / `query.ts`'s `resolveSession`:
 *  - relic's `session` command falls back to matching the text as a NAME
 *    (title or opening message) when no id/prefix hits. A name can match a
 *    COMPLETELY DIFFERENT session than the one asked for, and relic itself
 *    returns every such match rather than choosing one.
 *  - An id/prefix hit returns every row that shares the matched
 *    `session_uuid`, including subagent transcripts (`tier !== "session"`),
 *    in NO GUARANTEED ORDER -- relic's own CLI picks
 *    `rows.find(r => r.tier === "session") ?? rows[0]`, so grabbing
 *    `sessions[0]` (as an earlier version of this adapter did) can silently
 *    hand back a subagent transcript instead of the session itself.
 * An evidence-pinning caller needs the EXACT session it named, or nothing --
 * never a look-alike and never a child transcript standing in for it.
 *
 * Absence -- no matching row, no exact-uuid row, or no tier:"session" row
 * among the matches -- is `null`, never thrown, matching the rest of this
 * codebase's "absence is null, not an error" convention (`trace-v1.md`
 * section 6: "getTrace returns the literal row or null").
 */
export async function getSession(config: RelicAdapterConfig, sessionId: string): Promise<SessionRef | null> {
  // An empty id is not "no result", it is relic's OWN prefix query
  // (`session_uuid LIKE '${q}%'`) matching every row when `q` is empty --
  // refusing to spawn at all is the safe reading of "no id was given".
  if (sessionId === "") return null;
  assertNotFlagLike("sessionId", sessionId);

  const raw = await runRelicJson(config, ["session", sessionId, "--no-index"]);
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { sessions?: unknown }).sessions)) {
    failRelic("bad_output", "relic session output missing sessions array");
  }
  const output = raw as RelicSessionCommandOutput;
  const parent = output.sessions.find((row) => row && row.session_uuid === sessionId && row.tier === "session");
  if (!parent) return null;
  return rowToSessionRef(parent);
}
