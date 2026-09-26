import { requireBoolean, requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { MAX_PAGE_LIMIT } from "./context.parseListMessages";
import { name } from "./context.name";
import { nullableName } from "./context.nullableName";
import { parseRequest } from "./context.parseRequest";

export type ListSessionsRequest = {
  workspace_name: string;
  after_name: string | null;
  limit: number;
  include_total: boolean;
  /** K10 (overnight R18): null lists every session; true/false only open/closed ones. */
  is_active: boolean | null;
  /** K10: null lists every session; a name lists only its CURRENT memberships. */
  member_peer_name: string | null;
};

const KEYS = ["workspace_name", "after_name", "limit", "include_total"];
/** K10 filters: OPTIONAL, so every existing caller (UI v2, the dev stack, the
 *  acceptor probe) keeps its exact request; omitted and null mean "no filter". */
const FILTER_KEYS = ["is_active", "member_peer_name"];

export function parseListSessions(bytes: Uint8Array): ListSessionsRequest {
  const raw = parseRequest(bytes);
  const o = requireClosedObject(raw, [...KEYS, ...FILTER_KEYS.filter((key) => raw.has(key))], []);
  const rawLimit = o.get("limit");
  // A small JSON integer, deliberately: the page size is not an Int64 wire
  // field, so a decimal string here is a type error rather than a cursor.
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }
  const rawActive = o.get("is_active") ?? null;
  const request: ListSessionsRequest = {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    // The keyset cursor: null starts at the beginning, otherwise the page
    // starts STRICTLY after this name in ascending order.
    after_name: nullableName(o.get("after_name"), ["after_name"]),
    limit: rawLimit,
    // Explicit and REQUIRED, not defaulted by omission: a count is a second
    // full scan with no keyset to bound it, so a caller must ask for it on
    // purpose every time. (The K10 filters are the only optional keys here.)
    include_total: requireBoolean(o.get("include_total") ?? null, ["include_total"]),
    is_active: rawActive === null ? null : requireBoolean(rawActive, ["is_active"]),
    member_peer_name: nullableName(o.get("member_peer_name") ?? null, ["member_peer_name"]),
  };
  // A total over BOTH filters would need every membership joined to its
  // session in one count -- an unbounded scan the kernel does not run -- so
  // it is refused, never approximated.
  if (request.include_total && request.is_active !== null && request.member_peer_name !== null) {
    fail("invalid_value", ["include_total"], "no total for is_active together with member_peer_name");
  }
  return request;
}
