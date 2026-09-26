import { PublicationError } from "../publication/service";
import type { RequestAuthority } from "./registry";
import { PEER_FIELDS } from "./registry.peerFields";
import { findUnboundPeer } from "./transport.findUnboundPeer";

/**
 * #87 / R3 anti-spoofing, shared by HTTP and MCP: when the admitting grant
 * carries a `peers` binding, refuse (`forbidden`, 403) any caller-asserted
 * peer (`registry.peerFields.ts`) the binding does not list. Run after
 * admission and BEFORE any writer is opened or kernel runs; inert when unbound.
 *
 * A method the table does not classify at all is refused at the request root
 * under a binding: an unreviewed method may carry an acting peer this check
 * cannot see, and "not yet classified" must never read as "asserts none".
 * `transport-peer-fields.test.ts` keeps the table equal to the registry.
 */
export function requireBoundPeers(method: string, bytes: Uint8Array, authority: RequestAuthority): void {
  if (authority.peers === null) return;
  if (!Object.hasOwn(PEER_FIELDS, method)) throw new PublicationError("forbidden", "");
  const pointer = findUnboundPeer(bytes, PEER_FIELDS[method]!, authority.peers);
  if (pointer !== null) throw new PublicationError("forbidden", pointer);
}
