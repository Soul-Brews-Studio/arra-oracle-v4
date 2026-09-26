import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";

/**
 * `to:[peer]` names the other oracles a thread is addressed to; each is
 * JOINED, and joining is acting as that peer (R3 `peers` binding). So, before
 * anything is written: under a binding every recipient must be bound, and
 * every recipient must already be a registered peer of this bank -- an oracle
 * registers itself; v4 never registers one on another's behalf.
 */
export async function requireRecipients(context: V3ToolContext, to: readonly string[]): Promise<void> {
  const bound = context.authority.peers;
  for (const [index, peer] of to.entries()) {
    if (bound !== null && !bound.includes(peer)) {
      throw new CompatError(context.tool, "unsupported_argument", `this credential may not add ${peer} to a thread`,
        "joining is acting as that peer, and the grant's peers binding does not list it", { path: `/to/${index}` });
    }
  }
  for (const [index, peer] of to.entries()) {
    if ((await context.kb("getPeer", { peer_name: peer })) === null) {
      throw new CompatError(context.tool, "unsupported_argument", `peer ${peer} is not registered in this bank`,
        "an oracle registers itself (it speaks once as that peer); v4 never registers one for another", { path: `/to/${index}` });
    }
  }
}
