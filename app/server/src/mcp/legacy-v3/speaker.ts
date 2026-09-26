import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";
import { derivedId } from "./ids.derivedId";

/**
 * A7 / D8: who speaks on this call. The tool argument `peer` wins, then the
 * connection's X-Arra-Peer; both are caller ASSERTIONS, so under a grant
 * `peers` binding the name must be listed (the header was already checked by
 * the service; the argument is checked here, BEFORE any peer row is
 * written). Never derived from the bearer, the user-agent or cwd.
 *
 * A named speaker is ensured once: `getPeer`, else an idempotent
 * `registerPeer` under an id derived from the name. Null means no speaker,
 * and knowledge writes then publish with no author.
 */
export async function ensureSpeaker(context: V3ToolContext, args: Record<string, unknown>): Promise<string | null> {
  let speaker = context.assertedPeer;
  if (Object.hasOwn(args, "peer") && args.peer !== null && args.peer !== undefined) {
    if (typeof args.peer !== "string" || args.peer.trim() === "") {
      throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /peer: expected a peer name", "peer must be a nonblank string", { path: "/peer" });
    }
    speaker = args.peer;
    const bound = context.authority.peers;
    if (bound !== null && !bound.includes(speaker)) {
      throw new CompatError(context.tool, "unsupported_argument", `peer ${speaker} is not bound to this credential`,
        "this credential's grant lists the peers it may speak as, and this is not one of them", { path: "/peer" });
    }
  }
  if (speaker === null) return null;
  const existing = await context.kb("getPeer", { peer_name: speaker });
  if (existing === null) {
    try {
      await context.kb("registerPeer", { peer_id: derivedId(context.bank, "peer", speaker), name: speaker });
    } catch (error) {
      // Another writer registered the name first: theirs is the peer.
      if ((error as { code?: unknown }).code !== "conflict" || (await context.kb("getPeer", { peer_name: speaker })) === null) throw error;
    }
  }
  return speaker;
}
