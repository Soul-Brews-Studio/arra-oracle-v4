import { requireClosedObject } from "../../contracts/common";
import { chunkerVersion } from "./chunker-version";
import { embeddingProfile } from "./embedding-profile";
import { name } from "./name";
import { nanoidField } from "./nanoid-field";
import { parseRequest } from "./parse-request";
import type { EmbeddingProfileRequest } from "./types";

const INDEX_KEYS = [
  "workspace_name",
  "node_id",
  "revision_id",
  "chunker_version",
  "embedding_profile",
] as const;

export type IndexRevisionChunksRequest = {
  workspace_name: string;
  node_id: string;
  revision_id: string;
  chunker_version: string;
  embedding_profile: EmbeddingProfileRequest;
};

export function parseIndexRevision(bytes: Uint8Array): IndexRevisionChunksRequest {
  const request = requireClosedObject(parseRequest(bytes), INDEX_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    node_id: nanoidField(request.get("node_id"), ["node_id"]),
    revision_id: nanoidField(request.get("revision_id"), ["revision_id"]),
    chunker_version: chunkerVersion(request.get("chunker_version"), ["chunker_version"]),
    embedding_profile: embeddingProfile(request.get("embedding_profile"), ["embedding_profile"]),
  };
}
