import { requireClosedObject } from "../contracts/common";
import { DEFAULT_EMBEDDING_PROFILE } from "./search-chunk.defaultEmbeddingProfile";
import { name } from "./search-chunk.name";
import { parseRequest } from "./search-chunk.parseRequest";
import { searchLimit } from "./search-chunk.searchLimit";
import { searchQuery } from "./search-chunk.searchQuery";

const REQUIRED = ["workspace_name", "query"] as const;
const OPTIONAL = ["limit", "embedding_profile"] as const;

export type SearchKnowledgeSemanticRequest = {
  workspace_name: string;
  query: string;
  limit: number;
  embedding_profile: string;
};

/**
 * `{workspace_name, query, limit?, embedding_profile?}`.
 *
 * `embedding_profile` is the stored profile NAME (`listSearchChunks`'s
 * spelling), not the index-time `{name, dims}` object: the dimension is frozen
 * by the column, so a query has nothing to assert about it. Absent or null
 * means `DEFAULT_EMBEDDING_PROFILE`. Whether a query embedder can actually
 * serve that profile is a deployment fact, decided in the service.
 */
export function parseSearchKnowledgeSemantic(bytes: Uint8Array): SearchKnowledgeSemanticRequest {
  const raw = parseRequest(bytes);
  const request = requireClosedObject(raw, [...REQUIRED, ...OPTIONAL.filter((key) => raw.has(key))], []);
  const profile = request.get("embedding_profile");
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    query: searchQuery(request.get("query"), ["query"]),
    limit: searchLimit(request.get("limit"), ["limit"]),
    embedding_profile:
      profile === undefined || profile === null ? DEFAULT_EMBEDDING_PROFILE : name(profile, ["embedding_profile"]),
  };
}
