import { requireClosedObject } from "../../contracts/common";
import { name } from "./name";
import { parseRequest } from "./parse-request";

export type GetPeerRequest = { workspace_name: string; peer_name: string };

export function parseGetPeer(bytes: Uint8Array): GetPeerRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "peer_name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    peer_name: name(o.get("peer_name"), ["peer_name"]),
  };
}
