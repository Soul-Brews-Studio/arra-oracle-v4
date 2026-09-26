import { requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { int64Text } from "./context.int64Text";
import { name } from "./context.name";
import { parseRequest } from "./context.parseRequest";
import { REQUESTER_KEY, requesterPeerName } from "./context.requesterPeerName";

/** Page size ceiling for listMessages. A small JSON integer, NOT an Int64. */
export const MAX_PAGE_LIMIT = 100;

export type ListMessagesRequest = {
  workspace_name: string;
  session_name: string;
  after_seq: string | null;
  limit: number;
  /** #87 / R3: optional; null means the audit:read operator view. */
  requester_peer_name: string | null;
};

const KEYS = ["workspace_name", "session_name", "after_seq", "limit"];

export function parseListMessages(bytes: Uint8Array): ListMessagesRequest {
  const raw = parseRequest(bytes);
  // Closed as before; the optional requester is admitted only when present.
  const o = requireClosedObject(raw, raw.has(REQUESTER_KEY) ? [...KEYS, REQUESTER_KEY] : KEYS, []);
  const rawLimit = o.get("limit");
  // A small JSON integer, deliberately: the page size is not an Int64 wire
  // field, so a decimal string here is a type error rather than a cursor.
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }
  const rawAfter = o.get("after_seq");
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    after_seq: rawAfter === null ? null : int64Text(rawAfter, ["after_seq"]),
    limit: rawLimit,
    requester_peer_name: requesterPeerName(o),
  };
}
