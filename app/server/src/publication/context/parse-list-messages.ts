import { requireClosedObject } from "../../contracts/common";
import { fail } from "../../contracts/errors";
import { int64Text } from "./int64-text";
import { name } from "./name";
import { parseRequest } from "./parse-request";

/** Page size ceiling for listMessages. A small JSON integer, NOT an Int64. */
export const MAX_PAGE_LIMIT = 100;

export type ListMessagesRequest = {
  workspace_name: string;
  session_name: string;
  after_seq: string | null;
  limit: number;
};

export function parseListMessages(bytes: Uint8Array): ListMessagesRequest {
  const o = requireClosedObject(
    parseRequest(bytes),
    ["workspace_name", "session_name", "after_seq", "limit"],
    [],
  );
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
  };
}
