import { requireClosedObject, requireEnum } from "../contracts/common";
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
  /** K11 (overnight R18): optional; "asc" when omitted, exactly as before. */
  direction: "asc" | "desc";
  /** K11: the EXCLUSIVE upper cursor of a desc read; null starts at the newest. */
  before_seq: string | null;
};

const KEYS = ["workspace_name", "session_name", "after_seq", "limit"];
/** Admitted only when present, so every existing request is unchanged. */
const OPTIONAL = [REQUESTER_KEY, "direction", "before_seq"];

export function parseListMessages(bytes: Uint8Array): ListMessagesRequest {
  const raw = parseRequest(bytes);
  // Closed as before; the optional keys are admitted only when present.
  const o = requireClosedObject(raw, [...KEYS, ...OPTIONAL.filter((key) => raw.has(key))], []);
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
  const rawBefore = o.get("before_seq") ?? null;
  const request: ListMessagesRequest = {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    after_seq: rawAfter === null ? null : int64Text(rawAfter, ["after_seq"]),
    limit: rawLimit,
    requester_peer_name: requesterPeerName(o),
    direction: raw.has("direction") ? requireEnum(o.get("direction")!, ["asc", "desc"] as const, ["direction"]) : "asc",
    before_seq: rawBefore === null ? null : int64Text(rawBefore, ["before_seq"]),
  };
  // One cursor per direction, so a page can never be bounded on both sides
  // by a caller who meant only one of them.
  if (request.direction === "asc" && request.before_seq !== null) {
    fail("invalid_value", ["before_seq"], "before_seq pages a desc read; an asc read pages with after_seq");
  }
  if (request.direction === "desc" && request.after_seq !== null) {
    fail("invalid_value", ["after_seq"], "after_seq pages an asc read; a desc read pages with before_seq");
  }
  return request;
}
