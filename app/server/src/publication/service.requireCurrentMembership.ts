import { encodePeerRow, encodeSessionPeerRow } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { PEERS, SESSION_PEERS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * The peer must exist AND hold a CURRENT active membership.
 *
 * Applied to replays as well as new items: a historical replay after the peer
 * left is refused. That refusal never deletes history -- reads still return the
 * message; only new or replayed appends require present membership.
 */
export async function requireCurrentMembership(
  adapter: DatasetAdapter,
  workspace: string,
  session: string,
  peerName: string,
  path: string,
): Promise<void> {
  await adapter.refresh(PEERS);
  const peer = await contextOne(adapter, PEERS, `${contextScope(workspace)} AND name = ${quote(peerName)}`);
  if (peer === null) failPublication("invalid_reference", path);
  // Structural validity of the stored peer is required, not assumed.
  encodePeerRow(peer);

  await adapter.refresh(SESSION_PEERS);
  const membership = await contextOne(
    adapter,
    SESSION_PEERS,
    `${contextScope(workspace)} AND session_name = ${quote(session)} AND peer_name = ${quote(peerName)}`,
  );
  if (membership === null) failPublication("invalid_reference", path);
  if (encodeSessionPeerRow(membership).left_at !== null) failPublication("invalid_reference", path);
}
