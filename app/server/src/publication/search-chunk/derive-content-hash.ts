import { sha256HexWithDomain } from "../../contracts/common";

/** Domain string for the per-chunk content digest. */
export const SEARCH_CHUNK_CONTENT_DOMAIN = "arra-search-chunk-content/v1";

export function deriveContentHash(text: string): string {
  return sha256HexWithDomain(SEARCH_CHUNK_CONTENT_DOMAIN, text);
}
