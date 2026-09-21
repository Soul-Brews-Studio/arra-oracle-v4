import { requireClosedObject } from "../contracts/common";
import { parseRequest } from "./taxonomy.parseRequest";
import { requireId } from "./taxonomy.requireId";
import { requireNullableId } from "./taxonomy.requireNullableId";
import { requireWorkspace } from "./taxonomy.requireWorkspace";

export type ReparentTermRequest = {
  workspace_name: string;
  term_id: string;
  expected_parent_id: string | null;
  parent_id: string | null;
};

export function parseReparentTerm(bytes: Uint8Array): ReparentTermRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "term_id", "expected_parent_id", "parent_id"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    term_id: requireId(request.get("term_id"), ["term_id"]),
    expected_parent_id: requireNullableId(request.get("expected_parent_id"), ["expected_parent_id"]),
    parent_id: requireNullableId(request.get("parent_id"), ["parent_id"]),
  };
}
