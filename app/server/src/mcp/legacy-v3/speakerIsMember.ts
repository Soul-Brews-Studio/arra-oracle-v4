import type { V3ToolContext } from "./handlers";

/**
 * Whether `speaker` holds CURRENT membership of `session`, asked the way the
 * kernel answers it: K10 `listSessionMembers` read AS that peer (R3), which
 * refuses anyone else -- a stranger, a departed member, an unregistered name --
 * with `invalid_reference /requester_peer_name`. Reads one row; writes nothing.
 */
export async function speakerIsMember(context: V3ToolContext, session: string, speaker: string): Promise<boolean> {
  try {
    await context.kb("listSessionMembers", { session_name: session, requester_peer_name: speaker, after_name: null, limit: 1 });
    return true;
  } catch (error) {
    const e = error as { code?: unknown; path?: unknown };
    if (e.code === "invalid_reference" && e.path === "/requester_peer_name") return false;
    throw error;
  }
}
