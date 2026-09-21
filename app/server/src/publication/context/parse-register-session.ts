import { requireClosedObject } from "../../contracts/common";
import { name } from "./name";
import { nanoid } from "./nanoid";
import { parseRequest } from "./parse-request";

export type RegisterSessionRequest = { workspace_name: string; session_id: string; name: string };

export function parseRegisterSession(bytes: Uint8Array): RegisterSessionRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "session_id", "name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_id: nanoid(o.get("session_id"), ["session_id"]),
    name: name(o.get("name"), ["name"]),
  };
}
