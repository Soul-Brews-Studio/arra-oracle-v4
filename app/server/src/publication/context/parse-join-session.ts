import { requireClosedObject } from "../../contracts/common";
import { name } from "./name";
import { parseRequest } from "./parse-request";

export type JoinSessionRequest = { workspace_name: string; session_name: string; peer_name: string };

export function parseJoinSession(bytes: Uint8Array): JoinSessionRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "session_name", "peer_name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    peer_name: name(o.get("peer_name"), ["peer_name"]),
  };
}
