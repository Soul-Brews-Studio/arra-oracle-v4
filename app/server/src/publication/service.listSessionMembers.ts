import { MAX_RESULT_WIRE_BYTES, type RequestAuthority, encodeSessionPeerRow, parseListSessionMembers, requireMessageReadAuthority, rowWireBytes } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { SESSIONS, SESSION_PEERS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireCurrentMembership } from "./service.requireCurrentMembership";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/**
 * K10 `listSessionMembers` (docs/overnight/V3-PARITY.md §5; R18): the first
 * read of `session_peers`. One session's membership rows, keyset-paged by
 * peer name, departed members included with `left_at` set -- membership is
 * history, and leaving never erases it.
 *
 * Behind the SAME R3 boundary as the messages (listMessages/getMessage): who
 * belongs to a session is who talks to whom. A named `requester_peer_name`
 * must be inside the grant's binding and hold CURRENT membership; with none,
 * only the audit:read operator view reads. Without this, a credential bound
 * to one peer could list any session's members here and walk around the
 * binding on `listSessions.member_peer_name`.
 */
export async function listSessionMembers(
  reader: DatasetAdapter,
  requestBytes: Uint8Array,
  authority: RequestAuthority,
): Promise<{ rows: Record<string, unknown>[]; next_after_name: string | null }> {
  const request = parseListSessionMembers(requestBytes);
  requireMessageReadAuthority(request.requester_peer_name, authority);
  await requireWorkspace(reader, request.workspace_name);
  await reader.refresh(SESSIONS);
  const workspace = contextScope(request.workspace_name);
  const session = await contextOne(reader, SESSIONS, `${workspace} AND name = ${quote(request.session_name)}`);
  if (session === null) failPublication("invalid_reference", "/session_name");
  // Session existence is not secret (listSessions shows it), so the member
  // check after it reveals nothing a caller could not already list.
  if (request.requester_peer_name !== null) {
    await requireCurrentMembership(reader, request.workspace_name, request.session_name, request.requester_peer_name, "/requester_peer_name");
  }

  await reader.refresh(SESSION_PEERS);
  const scope = `${workspace} AND session_name = ${quote(request.session_name)}`;
  // KEYSET, never offset: (workspace, session, peer) is unique, so ascending
  // peer name is a total order, and limit+1 decides continuation.
  const selected = await reader.orderedProjection(
    SESSION_PEERS,
    scope + (request.after_name === null ? "" : ` AND peer_name > ${quote(request.after_name)}`),
    ["peer_name"],
    { column: "peer_name", ascending: true },
    request.limit + 1,
  );
  const names: string[] = [];
  for (const row of selected) {
    const peer = row.peer_name;
    // The lookahead row is validated too: a duplicate straddling the limit
    // would otherwise split silently across two pages.
    if (typeof peer !== "string" || names.includes(peer)) failPublication("integrity_failure", "");
    names.push(peer);
  }
  const page = names.slice(0, request.limit);
  const byPeer = new Map<string, Record<string, unknown>>();
  if (page.length > 0) {
    const found = await reader.query(SESSION_PEERS, `${scope} AND peer_name IN (${page.map(quote).join(", ")})`, page.length + 1);
    for (const row of found) {
      const encoded = encodeSessionPeerRow(row);
      if (byPeer.has(encoded.peer_name as string)) failPublication("integrity_failure", "");
      byPeer.set(encoded.peer_name as string, encoded);
    }
  }
  const rows: Record<string, unknown>[] = [];
  let budget = 1;
  for (const peer of page) {
    const row = byPeer.get(peer);
    if (row === undefined) failPublication("integrity_failure", "");
    budget += rowWireBytes(row) + 1;
    if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
    rows.push(row);
  }
  return { rows, next_after_name: names.length > request.limit ? page[page.length - 1]! : null };
}
