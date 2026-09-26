import { failRelic } from "./relic.errors";
import { runRelicJson } from "./relic.runRelicJson";
import type { RelicAdapterConfig, RelicSearchCommandOutput, RelicSearchHit } from "./relic.types";
import type { SessionRef } from "./session-source.types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** relic's own hit cap (`search --json --limit N`) is per-EVENT, not
 *  per-session, and one session can hold many matching events. Overfetch so
 *  a session whose best hit is not the very first result is not silently
 *  dropped by a limit that only ever counted DISTINCT sessions elsewhere. */
const OVERFETCH_FACTOR = 5;
const MAX_OVERFETCH = 500;

function hitToRef(hit: RelicSearchHit): SessionRef {
  return {
    sourceBank: bankFromRepo(hit.repo),
    provider: hit.source,
    sessionUuid: hit.session_uuid,
    transcriptRef: hit.file_path,
    title: null,
    startedAt: null,
    endedAt: null,
  };
}

function bankFromRepo(repo: string): string {
  const slash = repo.indexOf("/");
  return slash === -1 ? repo : repo.slice(0, slash);
}

/**
 * `SessionSource.find`: `relic search <query> --json`, grouped down to one
 * `SessionRef` per DISTINCT session, in relic's own BM25 rank order (its
 * first, highest-scored hit per session wins). relic's own guidance
 * (`relic --help`) is that this ranks TOPICS, not exact facts -- callers
 * choosing an event to pin should follow up with `read` on the returned
 * session rather than trusting `find`'s ranking alone.
 *
 * An empty query returns `[]` without spawning anything: relic's `search`
 * takes a required positional query, and an empty one names no topic to
 * defend a result set for.
 */
export async function findSessions(
  config: RelicAdapterConfig,
  query: string,
  limit = DEFAULT_LIMIT,
): Promise<SessionRef[]> {
  if (query === "") return [];
  const boundedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
  const overfetch = Math.min(boundedLimit * OVERFETCH_FACTOR, MAX_OVERFETCH);

  const raw = await runRelicJson(config, ["search", query, "--limit", String(overfetch)]);
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { hits?: unknown }).hits)) {
    failRelic("bad_output", "relic search output missing hits array");
  }
  const output = raw as RelicSearchCommandOutput;

  const bySession = new Map<string, SessionRef>();
  for (const hit of output.hits) {
    if (typeof hit.session_uuid !== "string" || hit.session_uuid === "") continue;
    if (!bySession.has(hit.session_uuid)) bySession.set(hit.session_uuid, hitToRef(hit));
    if (bySession.size >= boundedLimit) break;
  }
  return [...bySession.values()];
}
