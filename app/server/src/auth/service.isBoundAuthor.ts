/**
 * #87 / R3 (docs/overnight/DECISIONS.md) on the LEGACY memories write: may
 * this row be written under the admitting grant's arra-auth/v1 `peers`
 * binding?
 *
 * `peer_name` is the row's caller-asserted AUTHOR ("Who wrote it",
 * mcp/tools.ts), so it is bound exactly like a knowledge author
 * (`knowledge/registry.peerFields.ts`). `subject_peer_name` is who the row is
 * ABOUT -- writing about a peer is not acting as it -- so, like a revision's
 * subject, it is never consulted.
 *
 * True when the grant carries no binding (the trust unit stays the workspace,
 * behaviour unchanged) or the row asserts no author. Both `remember` (MCP)
 * and `POST /api/memories` (HTTP) call this in `auth/service.ts`, after
 * admission and before the store is touched.
 */
export function isBoundAuthor(row: { readonly peer_name?: string }, peers: readonly string[] | null): boolean {
  return peers === null || row.peer_name === undefined || peers.includes(row.peer_name);
}
