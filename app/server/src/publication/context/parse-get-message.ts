import { requireClosedObject } from "../../contracts/common";
import { name } from "./name";
import { nanoid } from "./nanoid";
import { parseRequest } from "./parse-request";

export type GetMessageRequest = { workspace_name: string; public_id: string };

export function parseGetMessage(bytes: Uint8Array): GetMessageRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "public_id"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    public_id: nanoid(o.get("public_id"), ["public_id"]),
  };
}
