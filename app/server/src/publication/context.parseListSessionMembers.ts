import { requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { MAX_PAGE_LIMIT } from "./context.parseListMessages";
import { name } from "./context.name";
import { nullableName } from "./context.nullableName";
import { parseRequest } from "./context.parseRequest";

export type ListSessionMembersRequest = {
  workspace_name: string;
  session_name: string;
  after_name: string | null;
  limit: number;
};

/**
 * K10 `listSessionMembers` (docs/overnight/V3-PARITY.md §5; R18): one
 * session's membership rows, keyset-paged by peer name. Closed like every
 * context request; `after_name` is a peer-name cursor.
 */
export function parseListSessionMembers(bytes: Uint8Array): ListSessionMembersRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "session_name", "after_name", "limit"], []);
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
  };
}
