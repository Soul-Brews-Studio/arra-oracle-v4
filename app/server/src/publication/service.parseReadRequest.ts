import { closedKeys } from "./service.closedKeys";
import { parseRequest } from "./service.parseRequest";
import { requireNodeId } from "./service.requireNodeId";
import { requireWorkspaceName } from "./service.requireWorkspaceName";
import { type ReadRequest } from "./service.types";

export function parseReadRequest(requestBytes: unknown): ReadRequest {
  const o = parseRequest(requestBytes);
  closedKeys(o, ["workspace_name", "node_id"], "");
  return {
    workspace_name: requireWorkspaceName(o.get("workspace_name"), "/workspace_name"),
    node_id: requireNodeId(o.get("node_id"), "/node_id"),
  };
}
