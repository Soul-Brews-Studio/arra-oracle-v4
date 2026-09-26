import { requireClosedObject } from "../contracts/common";
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
  /** null: the query embedder's own profile, resolved by the service. */
  embedding_profile: string | null;
};

/**
 * `{workspace_name, query, limit?, embedding_profile?}`.
 *
 * `embedding_profile` is the stored profile NAME (`listSearchChunks`'s
 * spelling), not the index-time `{name, dims}` object: the dimension is frozen
 * by the column, so a query has nothing to assert about it. Absent or null
 * stays null here: "the profile this deployment's query embedder serves" is a
 * deployment fact, not grammar, so the SERVICE resolves it (and decides
 * whether an embedder can serve a named one).
 */
export function parseSearchKnowledgeSemantic(bytes: Uint8Array): SearchKnowledgeSemanticRequest {
  const raw = parseRequest(bytes);
  const request = requireClosedObject(raw, [...REQUIRED, ...OPTIONAL.filter((key) => raw.has(key))], []);
  const profile = request.get("embedding_profile");
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    query: searchQuery(request.get("query"), ["query"]),
    limit: searchLimit(request.get("limit"), ["limit"]),
    embedding_profile: profile === undefined || profile === null ? null : name(profile, ["embedding_profile"]),
  };
}
