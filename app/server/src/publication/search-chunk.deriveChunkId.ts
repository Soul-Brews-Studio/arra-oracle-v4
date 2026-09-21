import { sha256HexWithDomain } from "../contracts/common";

/**
 * Domain string for the chunk-id digest. Versioned like every other digest
 * domain in this package, so a future change to the id derivation is a new
 * domain rather than a silent reinterpretation of old ids.
 */
export const SEARCH_CHUNK_ID_DOMAIN = "arra-search-chunk-id/v1";

/**
 * Deterministic chunk id: sha256 over (revision_id, chunker_version,
 * embedding_profile, chunk_index), domain-separated.
 *
 * This is the ENTIRE idempotency mechanism for re-indexing: retrying
 * `indexRevisionChunks` for the same (revision, chunker_version,
 * embedding_profile) proposes the identical ids, so a re-run is a no-op
 * against already-written rows without any operation journal.
 */
export function deriveChunkId(
  revisionId: string,
  chunkerVersion: string,
  embeddingProfileName: string,
  chunkIndex: bigint,
): string {
  const material = JSON.stringify([revisionId, chunkerVersion, embeddingProfileName, chunkIndex.toString(10)]);
  return sha256HexWithDomain(SEARCH_CHUNK_ID_DOMAIN, material);
}
