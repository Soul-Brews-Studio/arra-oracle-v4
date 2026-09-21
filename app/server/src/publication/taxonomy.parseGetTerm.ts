import { requireClosedObject } from "../contracts/common";
import { parseRequest } from "./taxonomy.parseRequest";
import { requireId } from "./taxonomy.requireId";
import { requireWorkspace } from "./taxonomy.requireWorkspace";
import type { GetTermRequest } from "./taxonomy.types";

export function parseGetTerm(bytes: Uint8Array): GetTermRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "term_id"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    term_id: requireId(request.get("term_id"), ["term_id"]),
  };
}
