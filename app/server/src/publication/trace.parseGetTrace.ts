import { requireClosedObject, requireNanoid21 } from "../contracts/common";
import { parseRequest } from "./trace.parseRequest";
import { name } from "./trace.name";
import type { GetTraceRequest } from "./trace.types";

const GET_TRACE_KEYS = ["workspace_name", "id"] as const;

export function parseGetTrace(bytes: Uint8Array): GetTraceRequest {
  const request = requireClosedObject(parseRequest(bytes), GET_TRACE_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    id: requireNanoid21(request.get("id") ?? null, ["id"]),
  };
}
