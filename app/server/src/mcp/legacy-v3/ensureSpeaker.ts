import type { V3ToolContext } from "./handlers";
import { derivedId } from "./ids.derivedId";
import { resolveSpeaker } from "./resolveSpeaker";

/**
 * A7 / D8: who speaks on this call (`resolveSpeaker`: the `peer` argument,
 * else X-Arra-Peer, bound by the grant's `peers` BEFORE any peer row is
 * written), ensured to exist as a peer of this bank.
 *
 * A named speaker is ensured once: `getPeer`, else an idempotent
 * `registerPeer` under an id derived from the name. Null means no speaker,
 * and knowledge writes then publish with no author.
 */
export async function ensureSpeaker(context: V3ToolContext, args: Record<string, unknown>): Promise<string | null> {
  const speaker = resolveSpeaker(context, args);
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
