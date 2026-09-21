import { requireClosedObject } from "../../contracts/common";
import { name } from "./name";
import { parseRequest } from "./parse-request";

export type GetSessionRequest = { workspace_name: string; session_name: string };

export function parseGetSession(bytes: Uint8Array): GetSessionRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "session_name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
  };
}
