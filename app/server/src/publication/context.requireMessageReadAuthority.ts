import { failPublication } from "./errors";

/**
 * What the ADMITTED caller of a message read may do beyond the admitted
 * `content:read` itself (#87 / R3, docs/overnight/DECISIONS.md).
 *
 * Built by the transport from the policy snapshot that admitted the request
 * (`knowledge/transport.ts` for HTTP, `auth/service.ts` for MCP) -- never from
 * request bytes, which is why it travels beside them rather than inside them.
 *
 * - `operator`: the principal ALSO holds `audit:read` on this workspace, so it
 *   may read every session without naming a requester (the operator view).
 * - `peers`: the grant's arra-auth/v1 `peers` binding, or null when the grant
 *   carries none. When present, a named requester must be one of them.
 */
export type RequestAuthority = {
  readonly operator: boolean;
  readonly peers: readonly string[] | null;
};

const REQUESTER_PATH = "/requester_peer_name";

/**
 * The storage-free half of the #87 read boundary, run BEFORE any dataset read
 * so a refused caller learns nothing about what the workspace holds.
 *
 * No requester: only the operator view may read (else `forbidden`). A named
 * requester must sit inside the grant's peer binding when one exists (else
 * `forbidden`); its CURRENT membership is then checked against storage by the
 * caller, with the same `requireCurrentMembership` getContext uses.
 *
 * The overnight R18 amendment applies the same rule to K10
 * `listSessionMembers` (who belongs to a session is behind the same boundary
 * as what they said) and to K9 `closeSession`'s `peer_name`, at `path`: a
 * close that names no member is the operator path, so it needs `audit:read`.
 *
 * A missing or malformed authority is a wiring fault, not a request fault: it
 * throws a plain TypeError and reads nothing, so a transport that forgets to
 * build one fails closed and loudly rather than defaulting to any view.
 */
export function requireMessageReadAuthority(requester: string | null, authority: unknown, path: string = REQUESTER_PATH): void {
  if (typeof authority !== "object" || authority === null) {
    throw new TypeError("message reads require the transport-built RequestAuthority");
  }
  const { operator, peers } = authority as Record<string, unknown>;
  if (typeof operator !== "boolean") throw new TypeError("RequestAuthority.operator must be a boolean");
  if (peers !== null && !(Array.isArray(peers) && peers.every((peer) => typeof peer === "string"))) {
    throw new TypeError("RequestAuthority.peers must be null or an array of peer names");
  }
  if (requester === null) {
    if (!operator) failPublication("forbidden", path);
    return;
  }
  if (peers !== null && !peers.includes(requester)) failPublication("forbidden", path);
}
