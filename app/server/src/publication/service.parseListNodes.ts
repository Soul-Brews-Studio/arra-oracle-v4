import { failPublication } from "./errors";
import { closedKeys } from "./service.closedKeys";
import { parseRequest } from "./service.parseRequest";
import { requireNodeId } from "./service.requireNodeId";
import { requireWorkspaceName } from "./service.requireWorkspaceName";

/** Page size ceiling for listNodes, matching listMessages' MAX_PAGE_LIMIT. */
export const MAX_PAGE_LIMIT = 100;

export type ListNodesRequest = {
  workspace_name: string;
  /** Keyset cursor: nullable nanoid21. A page starts STRICTLY after this id. */
  after_id: string | null;
  limit: number;
};

export function parseListNodes(requestBytes: Uint8Array): ListNodesRequest {
  const o = parseRequest(requestBytes);
  closedKeys(o, ["workspace_name", "after_id", "limit"], "");

  const workspace_name = requireWorkspaceName(o.get("workspace_name"), "/workspace_name");

  const rawAfter = o.get("after_id");
  const after_id = rawAfter === null || rawAfter === undefined ? null : requireNodeId(rawAfter, "/after_id");

  const rawLimit = o.get("limit");
  // A small JSON integer, deliberately: the page size is not an Int64 wire
  // field, so a decimal string here is a type error rather than a cursor.
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) failPublication("invalid_request", "/limit");
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) failPublication("invalid_request", "/limit");

  return { workspace_name, after_id, limit: rawLimit };
}
