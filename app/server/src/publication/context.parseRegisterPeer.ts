import { requireClosedObject } from "../contracts/common";
import { name } from "./context.name";
import { nanoid } from "./context.nanoid";
import { parseRequest } from "./context.parseRequest";

export type RegisterPeerRequest = { workspace_name: string; peer_id: string; name: string };

export function parseRegisterPeer(bytes: Uint8Array): RegisterPeerRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "peer_id", "name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    peer_id: nanoid(o.get("peer_id"), ["peer_id"]),
    name: name(o.get("name"), ["name"]),
  };
}
