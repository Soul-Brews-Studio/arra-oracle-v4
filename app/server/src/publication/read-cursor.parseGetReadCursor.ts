// Split out of read-cursor.ts (Nat style: one exported function per file).
// Contract: app/docs/contracts/read-cursor-v1.md

import { requireClosedObject } from "../contracts/common";
import { name } from "./read-cursor.name";
import { parseRequest } from "./read-cursor.parseRequest";

const GET_KEYS = ["workspace_name", "peer_name", "session_name"] as const;

export type GetReadCursorRequest = {
  workspace_name: string;
  peer_name: string;
  session_name: string;
};

export function parseGetReadCursor(bytes: Uint8Array): GetReadCursorRequest {
  const request = requireClosedObject(parseRequest(bytes), GET_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    peer_name: name(request.get("peer_name"), ["peer_name"]),
    session_name: name(request.get("session_name"), ["session_name"]),
  };
}
