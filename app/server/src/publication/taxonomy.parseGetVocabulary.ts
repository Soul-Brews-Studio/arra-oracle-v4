import { requireClosedObject } from "../contracts/common";
import { parseRequest } from "./taxonomy.parseRequest";
import { requireId } from "./taxonomy.requireId";
import { requireWorkspace } from "./taxonomy.requireWorkspace";

export type GetVocabularyRequest = { workspace_name: string; vocabulary_id: string };

export function parseGetVocabulary(bytes: Uint8Array): GetVocabularyRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "vocabulary_id"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    vocabulary_id: requireId(request.get("vocabulary_id"), ["vocabulary_id"]),
  };
}
