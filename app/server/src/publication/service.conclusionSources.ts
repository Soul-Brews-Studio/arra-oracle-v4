import { type ConclusionSource } from "./chat";
import { failPublication } from "./errors";

/**
 * The source handles of one ALREADY-ENCODED revision (D3b), from its own
 * `link_snapshot_json`. A handle naming a session (`message`, `session`)
 * the caller may not read is DROPPED; `incomplete` says only that something
 * was, never what or how many (DESIGN.md §12: "never leaked counts/IDs").
 * Every other kind (a node revision, trace, URL, commit...) is workspace data
 * already readable under the same admission, so it is returned as stored.
 */
export async function conclusionSources(
  encodedRevision: Record<string, unknown>,
  canSeeSession: (session: string) => Promise<boolean>,
): Promise<{ sources: ConclusionSource[]; incomplete: boolean }> {
  const text = encodedRevision.link_snapshot_json;
  if (typeof text !== "string") failPublication("integrity_failure", "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failPublication("integrity_failure", "");
  }
  if (!Array.isArray(parsed)) failPublication("integrity_failure", "");
  const sources: ConclusionSource[] = [];
  let incomplete = false;
  for (const entry of parsed as Record<string, unknown>[]) {
    if (entry === null || typeof entry !== "object") failPublication("integrity_failure", "");
    const { relation, target_kind, target, capture_status } = entry;
    if (typeof relation !== "string" || typeof target_kind !== "string" || typeof capture_status !== "string") {
      failPublication("integrity_failure", "");
    }
    const session = (target as Record<string, unknown> | null)?.session_name;
    if ((target_kind === "message" || target_kind === "session") && (typeof session !== "string" || !(await canSeeSession(session)))) {
      incomplete = true;
      continue;
    }
    sources.push({ relation, target_kind, target, capture_status });
  }
  return { sources, incomplete };
}
