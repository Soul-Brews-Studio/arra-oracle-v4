import { requireClosedObject } from "../contracts/common";
import { name } from "./search-chunk.name";
import { parseRequest } from "./search-chunk.parseRequest";

const GET_SEARCH_FRESHNESS_KEYS = ["workspace_name"] as const;

export type GetSearchFreshnessRequest = { workspace_name: string };

/**
 * `getSearchFreshness` reports on the ONE implemented chunker/profile pair
 * (`CHUNKER_VERSION`, the active embedding profile), so unlike
 * `parseListChunks` there is nothing else for a caller to name -- adding a
 * `chunker_version` or `embedding_profile` field here would let a caller ask
 * about a combination this server has never produced.
 */
export function parseGetSearchFreshness(bytes: Uint8Array): GetSearchFreshnessRequest {
  const request = requireClosedObject(parseRequest(bytes), GET_SEARCH_FRESHNESS_KEYS, []);
  return { workspace_name: name(request.get("workspace_name"), ["workspace_name"]) };
}
