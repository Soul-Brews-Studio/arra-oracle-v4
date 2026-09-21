import { requireClosedObject } from "../../contracts/common";
import { parseRequest } from "./parse-request";
import { requireId } from "./require-id";
import { requireName } from "./require-name";
import { requireNullableDescription } from "./require-nullable-description";
import { requireNullableId } from "./require-nullable-id";
import { requireWorkspace } from "./require-workspace";

export type CreateTermRequest = {
  workspace_name: string;
  term_id: string;
  vocabulary_id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
};

export function parseCreateTerm(bytes: Uint8Array): CreateTermRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "term_id", "vocabulary_id", "name", "description", "parent_id"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    term_id: requireId(request.get("term_id"), ["term_id"]),
    vocabulary_id: requireId(request.get("vocabulary_id"), ["vocabulary_id"]),
    name: requireName(request.get("name"), ["name"]),
    description: requireNullableDescription(request.get("description"), ["description"]),
    parent_id: requireNullableId(request.get("parent_id"), ["parent_id"]),
  };
}
