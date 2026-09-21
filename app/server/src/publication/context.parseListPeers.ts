import { requireBoolean, requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { MAX_PAGE_LIMIT } from "./context.parseListMessages";
import { name } from "./context.name";
import { nullableName } from "./context.nullableName";
import { parseRequest } from "./context.parseRequest";

export type ListPeersRequest = {
  workspace_name: string;
  after_name: string | null;
  limit: number;
  include_total: boolean;
};

export function parseListPeers(bytes: Uint8Array): ListPeersRequest {
  const o = requireClosedObject(
    parseRequest(bytes),
    ["workspace_name", "after_name", "limit", "include_total"],
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
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    // The keyset cursor: null starts at the beginning, otherwise the page
    // starts STRICTLY after this name in ascending order.
    after_name: nullableName(o.get("after_name"), ["after_name"]),
    limit: rawLimit,
    // Explicit and REQUIRED, not defaulted by omission -- this grammar has no
    // optional keys anywhere else, and a count is a second full scan with no
    // keyset to bound it, so a caller must ask for it on purpose every time.
    include_total: requireBoolean(o.get("include_total") ?? null, ["include_total"]),
  };
}
