import { requireClosedObject } from "../contracts/common";
import { parseRequest } from "./taxonomy.parseRequest";
import { requireId } from "./taxonomy.requireId";
import { requireName } from "./taxonomy.requireName";
import { requireWorkspace } from "./taxonomy.requireWorkspace";

export type LookupTermByNameRequest = { workspace_name: string; vocabulary_id: string; name: string };

/**
 * K2 (docs/overnight/V3-PARITY.md §5): find a term by its exact name inside
 * one vocabulary. Term names are unique per vocabulary, never across the
 * workspace, so the vocabulary id is required.
 */
export function parseLookupTermByName(bytes: Uint8Array): LookupTermByNameRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "vocabulary_id", "name"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    vocabulary_id: requireId(request.get("vocabulary_id"), ["vocabulary_id"]),
    name: requireName(request.get("name"), ["name"]),
  };
}
