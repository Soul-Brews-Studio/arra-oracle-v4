import type { V3ToolContext } from "./handlers";

/** Memberships read per page, and pages read at most, when a thread reopens. */
const PAGE = 100;
const MAX_PAGES = 10;

/**
 * The CURRENT members of a closed thread to carry into its continuation
 * (K10 `listSessionMembers`), minus the speaker, split by whether this
 * credential may join them: under a `peers` binding, joining anyone else is
 * acting as them (R3), so those are returned as `skipped` for the caller to
 * name, never joined and never dropped silently.
 */
export async function carriedMembers(
  context: V3ToolContext,
  session: string,
  speaker: string,
): Promise<{ carried: string[]; skipped: string[]; complete: boolean }> {
  const bound = context.authority.peers;
  const carried: string[] = [];
  const skipped: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = (await context.kb("listSessionMembers", { session_name: session, after_name: after, limit: PAGE })) as {
      rows: { peer_name: string; left_at: string | null }[];
      next_after_name: string | null;
    };
    for (const row of result.rows) {
      if (row.left_at !== null || row.peer_name === speaker) continue;
      (bound === null || bound.includes(row.peer_name) ? carried : skipped).push(row.peer_name);
    }
    if (result.next_after_name === null) return { carried, skipped, complete: true };
    after = result.next_after_name;
  }
  return { carried, skipped, complete: false };
}
