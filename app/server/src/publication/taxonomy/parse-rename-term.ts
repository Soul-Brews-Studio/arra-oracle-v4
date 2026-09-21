import { requireClosedObject } from "../../contracts/common";
import { parseRequest } from "./parse-request";
import { requireId } from "./require-id";
import { requireName } from "./require-name";
import { requireWorkspace } from "./require-workspace";

export type RenameTermRequest = {
  workspace_name: string;
  term_id: string;
  expected_name: string;
  name: string;
};

export function parseRenameTerm(bytes: Uint8Array): RenameTermRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "term_id", "expected_name", "name"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    term_id: requireId(request.get("term_id"), ["term_id"]),
    expected_name: requireName(request.get("expected_name"), ["expected_name"]),
    name: requireName(request.get("name"), ["name"]),
  };
}
