import { requireClosedObject } from "../contracts/common";
import { RETIRE_KEYS, type RetireNodeRequest } from "./lifecycle.constants";
import { name } from "./lifecycle.name";
import { nodeId } from "./lifecycle.nodeId";
import { nullableName } from "./lifecycle.nullableName";
import { operationId } from "./lifecycle.operationId";
import { parseRequest } from "./lifecycle.parseRequest";
import { reason } from "./lifecycle.reason";

export function parseRetireNode(bytes: Uint8Array): RetireNodeRequest {
  const request = requireClosedObject(parseRequest(bytes), RETIRE_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    node_id: nodeId(request.get("node_id"), ["node_id"]),
    expected_revision_id: nodeId(request.get("expected_revision_id"), ["expected_revision_id"]),
    reason: reason(request.get("reason"), ["reason"]),
    peer_name: nullableName(request.get("peer_name"), ["peer_name"]),
    operation_id: operationId(request.get("operation_id"), ["operation_id"]),
  };
}
