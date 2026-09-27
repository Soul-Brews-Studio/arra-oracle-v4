import { encodePeerRow } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { PEERS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * D3b: a named perspective (observer, subject, or a representation's
 * requester) must be a registered peer of THIS workspace. An unknown name
 * fails closed with the same `invalid_reference` every other peer reference
 * uses, at the offending field's path. Null ("any") reads nothing.
 *
 * Existence only, never membership: naming a perspective is not acting as it,
 * so it grants and requires nothing beyond the peer being real.
 */
export async function requirePerspectivePeer(
  reader: DatasetAdapter,
  workspace: string,
  peerName: string | null,
  path: string,
): Promise<void> {
  if (peerName === null) return;
  await reader.refresh(PEERS);
  const peer = await contextOne(reader, PEERS, `${contextScope(workspace)} AND name = ${quote(peerName)}`);
  if (peer === null) failPublication("invalid_reference", path);
  encodePeerRow(peer);
}
