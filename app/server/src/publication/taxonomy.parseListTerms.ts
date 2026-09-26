import { requireBoolean, requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { parseRequest } from "./taxonomy.parseRequest";
import { requireId } from "./taxonomy.requireId";
import { requireNullableId } from "./taxonomy.requireNullableId";
import { requireWorkspace } from "./taxonomy.requireWorkspace";

/** Matches `listNodes`/`listPeers`' own page-size ceiling. */
export const MAX_PAGE_LIMIT = 100;

export type ListTermsRequest = {
  workspace_name: string;
  vocabulary_id: string;
  /** Keyset cursor: nullable nanoid21. A page starts STRICTLY after this id. */
  after_id: string | null;
  limit: number;
  /** Retired terms are hidden unless the caller asks for them (R7 `listNodes`
   *  `include_inactive` precedent) -- explicit and required, never defaulted
   *  by omission. */
  include_inactive: boolean;
};

/**
 * K6 (docs/overnight/V3-PARITY.md §5): a plain, paginated listing of one
 * vocabulary's terms. `getTerm`/`lookupTermByName` are get-by-one only; a
 * caller (the v3 adapter's `oracle_concepts` fallback, a UI browsing a
 * vocabulary) that wants every term needs this instead.
 */
export function parseListTerms(bytes: Uint8Array): ListTermsRequest {
  const request = requireClosedObject(
    parseRequest(bytes),
    ["workspace_name", "vocabulary_id", "after_id", "limit", "include_inactive"],
    [],
  );

  const rawLimit = request.get("limit");
  // A small JSON integer, deliberately: the page size is not an Int64 wire
  // field, so a decimal string here is a type error rather than a cursor.
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }

  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    vocabulary_id: requireId(request.get("vocabulary_id"), ["vocabulary_id"]),
    after_id: requireNullableId(request.get("after_id"), ["after_id"]),
    limit: rawLimit,
    include_inactive: requireBoolean(request.get("include_inactive") ?? null, ["include_inactive"]),
  };
}
