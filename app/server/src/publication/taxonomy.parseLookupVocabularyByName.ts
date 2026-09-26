import { requireClosedObject } from "../contracts/common";
import { parseRequest } from "./taxonomy.parseRequest";
import { requireName } from "./taxonomy.requireName";
import { requireWorkspace } from "./taxonomy.requireWorkspace";

export type LookupVocabularyByNameRequest = { workspace_name: string; name: string };

/**
 * K2 (docs/overnight/V3-PARITY.md §5): find a vocabulary by its exact name.
 * The name uses the create grammar (`requireName`: nonempty, 256 bytes, no
 * trim, no case fold), so any name a writer could store can be looked up and
 * nothing else can.
 */
export function parseLookupVocabularyByName(bytes: Uint8Array): LookupVocabularyByNameRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "name"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    name: requireName(request.get("name"), ["name"]),
  };
}
