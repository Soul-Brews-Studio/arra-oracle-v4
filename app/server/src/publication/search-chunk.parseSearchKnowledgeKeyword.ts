import { requireClosedObject } from "../contracts/common";
import { name } from "./search-chunk.name";
import { parseRequest } from "./search-chunk.parseRequest";
import { searchLimit } from "./search-chunk.searchLimit";
import { searchQuery } from "./search-chunk.searchQuery";

const REQUIRED = ["workspace_name", "query"] as const;
const OPTIONAL = ["limit"] as const;

export type SearchKnowledgeKeywordRequest = { workspace_name: string; query: string; limit: number };

/**
 * `{workspace_name, query, limit?}`. Closed: an optional key is admitted only
 * when present (the `requester_peer_name` idiom), so any other key -- an
 * `embedding_profile` included, since chunk text is identical under every
 * profile -- is `unexpected_field`.
 */
export function parseSearchKnowledgeKeyword(bytes: Uint8Array): SearchKnowledgeKeywordRequest {
  const raw = parseRequest(bytes);
  const request = requireClosedObject(raw, [...REQUIRED, ...OPTIONAL.filter((key) => raw.has(key))], []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    query: searchQuery(request.get("query"), ["query"]),
    limit: searchLimit(request.get("limit"), ["limit"]),
  };
}
