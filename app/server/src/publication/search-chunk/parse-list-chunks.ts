import { requireClosedObject } from "../../contracts/common";
import { chunkerVersion } from "./chunker-version";
import { name } from "./name";
import { nanoidField } from "./nanoid-field";
import { parseRequest } from "./parse-request";

// scoped on the SAME tuple the chunk id is keyed on: `indexRevisionChunks` is
// explicitly re-callable for one revision under different chunker versions
// and embedding profiles, and a list that did not scope on both would merge
// rows from unrelated indexing runs under one non-unique `chunk_index`.
const LIST_KEYS = ["workspace_name", "revision_id", "chunker_version", "embedding_profile"] as const;

export type ListChunksRequest = {
  workspace_name: string;
  revision_id: string;
  chunker_version: string;
  embedding_profile: string;
};

export function parseListChunks(bytes: Uint8Array): ListChunksRequest {
  const request = requireClosedObject(parseRequest(bytes), LIST_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    revision_id: nanoidField(request.get("revision_id"), ["revision_id"]),
    chunker_version: chunkerVersion(request.get("chunker_version"), ["chunker_version"]),
    embedding_profile: name(request.get("embedding_profile"), ["embedding_profile"]),
  };
}
