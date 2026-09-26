import { requireClosedObject } from "../contracts/common";
import { parseRequest } from "./taxonomy.parseRequest";
import { requireWorkspace } from "./taxonomy.requireWorkspace";

export type KnowledgeStatsRequest = { workspace_name: string };

/** K7 (docs/overnight/V3-PARITY.md §5): the whole request is the workspace. */
export function parseKnowledgeStats(bytes: Uint8Array): KnowledgeStatsRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name"], []);
  return { workspace_name: requireWorkspace(request.get("workspace_name")) };
}
