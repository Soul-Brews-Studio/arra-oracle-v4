import { requireClosedObject, requireSha256Hex } from "../contracts/common";
import { embeddingVector } from "./search-chunk.embeddingVector";
import { name } from "./search-chunk.name";
import { parseRequest } from "./search-chunk.parseRequest";

const WRITE_EMBEDDING_KEYS = ["workspace_name", "id", "embedding"] as const;

export type WriteChunkEmbeddingRequest = {
  workspace_name: string;
  id: string;
  embedding: number[];
};

/** `id` is a chunk id: `deriveChunkId`'s own domain is sha256 hex, so this
 *  reuses the same shape check as any other sha256-hex field rather than the
 *  looser `nanoidField` used for node/revision ids. */
export function parseWriteChunkEmbedding(bytes: Uint8Array): WriteChunkEmbeddingRequest {
  const request = requireClosedObject(parseRequest(bytes), WRITE_EMBEDDING_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    id: requireSha256Hex(request.get("id") ?? null, ["id"]),
    embedding: embeddingVector(request.get("embedding"), ["embedding"]),
  };
}
