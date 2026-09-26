import { requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { MAX_PAGE_LIMIT } from "./context.parseListMessages";
import { name } from "./context.name";
import { nullableName } from "./context.nullableName";
import { parseRequest } from "./context.parseRequest";
import { REQUESTER_KEY, requesterPeerName } from "./context.requesterPeerName";

export type ListSessionMembersRequest = {
  workspace_name: string;
  session_name: string;
  after_name: string | null;
  limit: number;
  /** R3, on listMessages' terms: optional; null means the audit:read operator view. */
  requester_peer_name: string | null;
};

const KEYS = ["workspace_name", "session_name", "after_name", "limit"];

/**
 * K10 `listSessionMembers` (docs/overnight/V3-PARITY.md §5; R18): one
 * session's membership rows, keyset-paged by peer name. Closed like every
 * context request; `after_name` is a peer-name cursor. The R3 requester is
 * admitted only when present, exactly as on listMessages/getMessage.
 */
export function parseListSessionMembers(bytes: Uint8Array): ListSessionMembersRequest {
  const raw = parseRequest(bytes);
  const o = requireClosedObject(raw, raw.has(REQUESTER_KEY) ? [...KEYS, REQUESTER_KEY] : KEYS, []);
  const rawLimit = o.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    after_name: nullableName(o.get("after_name"), ["after_name"]),
    limit: rawLimit,
    requester_peer_name: requesterPeerName(o),
  };
}
