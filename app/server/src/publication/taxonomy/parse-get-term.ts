import { requireClosedObject } from "../../contracts/common";
import { parseRequest } from "./parse-request";
import { requireId } from "./require-id";
import { requireWorkspace } from "./require-workspace";
import type { GetTermRequest } from "./types";

export function parseGetTerm(bytes: Uint8Array): GetTermRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "term_id"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    term_id: requireId(request.get("term_id"), ["term_id"]),
  };
}
