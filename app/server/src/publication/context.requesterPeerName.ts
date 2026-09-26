import type { JcsObject } from "../contracts/jcs";
import { name } from "./context.name";

/**
 * The first optional key in the context request grammar (#87 / R3,
 * docs/overnight/DECISIONS.md), accepted only by getMessage and listMessages.
 * (The overnight R18 amendment added more on the same terms: registerSession's
 * `h_metadata`, listSessions' two filters, listMessages' `direction` and
 * `before_seq`; see context-ingestion-v1.md.)
 *
 * Optional rather than required-nullable, deliberately: every existing
 * caller (UI v2, the dev stack, the acceptor probe) omits it and reads through
 * the audit:read operator view, and a required key would break all of them
 * for a field whose absence already has a meaning. Callers that always send
 * the key may send null; omitted and null are the same "no requester".
 */
export const REQUESTER_KEY = "requester_peer_name";

/** The requester named by an ALREADY-CLOSED request object, or null. */
export function requesterPeerName(o: JcsObject): string | null {
  const value = o.get(REQUESTER_KEY);
  return value === undefined || value === null ? null : name(value, [REQUESTER_KEY]);
}
