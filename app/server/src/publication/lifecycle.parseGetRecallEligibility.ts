import { requireClosedObject } from "../contracts/common";
import { ELIGIBILITY_KEYS, type GetRecallEligibilityRequest } from "./lifecycle.constants";
import { name } from "./lifecycle.name";
import { nodeId } from "./lifecycle.nodeId";
import { parseRequest } from "./lifecycle.parseRequest";

export function parseGetRecallEligibility(bytes: Uint8Array): GetRecallEligibilityRequest {
  const request = requireClosedObject(parseRequest(bytes), ELIGIBILITY_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    node_id: nodeId(request.get("node_id"), ["node_id"]),
  };
}
