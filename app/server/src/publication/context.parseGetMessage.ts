import { requireClosedObject } from "../contracts/common";
import { name } from "./context.name";
import { nanoid } from "./context.nanoid";
import { parseRequest } from "./context.parseRequest";
import { REQUESTER_KEY, requesterPeerName } from "./context.requesterPeerName";

export type GetMessageRequest = { workspace_name: string; public_id: string; requester_peer_name: string | null };

const KEYS = ["workspace_name", "public_id"];

export function parseGetMessage(bytes: Uint8Array): GetMessageRequest {
  const raw = parseRequest(bytes);
  // Closed as before; the optional requester is admitted only when present.
  const o = requireClosedObject(raw, raw.has(REQUESTER_KEY) ? [...KEYS, REQUESTER_KEY] : KEYS, []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    public_id: nanoid(o.get("public_id"), ["public_id"]),
    requester_peer_name: requesterPeerName(o),
  };
}
