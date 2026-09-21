import { requireClosedObject, requireNanoid21 } from "../../contracts/common";
import { parseRequest } from "./parseRequest";
import { name } from "./name";
import type { GetTraceRequest } from "./types";

const GET_TRACE_KEYS = ["workspace_name", "id"] as const;

export function parseGetTrace(bytes: Uint8Array): GetTraceRequest {
  const request = requireClosedObject(parseRequest(bytes), GET_TRACE_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    id: requireNanoid21(request.get("id") ?? null, ["id"]),
  };
}
