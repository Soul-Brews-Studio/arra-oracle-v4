/**
 * #30 search chunks -- the PURE half.
 *
 * Request grammar and the stored-row codec for `search_chunks_v1`, with no
 * SDK, connection or owner import. Everything here is decidable from bytes
 * alone, modelled on `read-cursor.ts`.
 *
 * Two physical facts drive this module, both measured against the live
 * schema rather than assumed:
 *
 * 1. `embedding` is `fixed_size_list<float32?>[384]`. The dimension is FROZEN
 *    by the column type itself -- a profile declaring any other dimension
 *    cannot be stored, so it is refused here, at the boundary, before a
 *    caller ever reaches the writer. See `./search-chunk.embeddingProfile.ts`.
 * 2. `status` is `utf8 NOT NULL` with no enum in the physical schema. The
 *    closed set is this module's own decision, not a stored constraint --
 *    a differently-configured writer could legally store a fourth value,
 *    which is why the stored codec's status check is integrity_failure, not
 *    a request-grammar rejection. See `./search-chunk.storedStatus.ts`.
 *
 * THIN BARREL: this file is now only a re-export surface. The implementation
 * lives one function per file, each named `search-chunk.<functionName>.ts`
 * beside this barrel -- see those files for the request grammar,
 * deterministic id/content derivation, the chunker, and the stored-row codec.
 */

export { EMBEDDING_DIMENSION } from "./search-chunk.embeddingProfile";
export { CHUNKER_VERSION } from "./search-chunk.chunkerVersion";
export { CHUNK_SIZE_CHARS, chunkText } from "./search-chunk.chunkText";
export { CHUNK_STATUSES, type ChunkStatus } from "./search-chunk.storedStatus";
export { MAX_RECONCILE_REVISIONS, type ReconcileSearchChunksRequest, parseReconcileSearch } from "./search-chunk.parseReconcileSearch";
export { SEARCH_CHUNK_FIELDS, encodeSearchChunkRow } from "./search-chunk.encodeSearchChunkRow";
export { storedEmbedding } from "./search-chunk.storedEmbedding";
export { storedTermIds } from "./search-chunk.storedTermIds";
export { type DigestProbeFn, type EmbeddingProfileRequest, type EmbedFn } from "./search-chunk.types";
export { type IndexRevisionChunksRequest, parseIndexRevision } from "./search-chunk.parseIndexRevision";
export { type ListChunksRequest, parseListChunks } from "./search-chunk.parseListChunks";
export { type GetSearchFreshnessRequest, parseGetSearchFreshness } from "./search-chunk.parseGetSearchFreshness";
export { type EmbedPendingChunksRequest, parseEmbedPendingChunks } from "./search-chunk.parseEmbedPendingChunks";
export { MAX_EMBED_ATTEMPTS } from "./search-chunk.embedAttempts";
export {
  EMBED_ERROR_CODES,
  EmbedTimeoutError,
  classifyEmbedError,
  type EmbedErrorCode,
} from "./search-chunk.classifyEmbedError";
export { type WriteChunkEmbeddingRequest, parseWriteChunkEmbedding } from "./search-chunk.parseWriteChunkEmbedding";
export { SEARCH_CHUNK_ID_DOMAIN, deriveChunkId } from "./search-chunk.deriveChunkId";
export { SEARCH_CHUNK_CONTENT_DOMAIN, deriveContentHash } from "./search-chunk.deriveContentHash";
export {
  type EmbeddingProfile,
  ACTIVE_EMBEDDING_MODEL_NAME,
  ACTIVE_EMBEDDING_PROFILE,
  INPUT_RULE,
} from "./search-chunk.profiles";
export { activeEmbeddingProfileId } from "./search-chunk.activeEmbeddingProfileId";
export { requireRegisteredEmbeddingProfileName } from "./search-chunk.requireRegisteredEmbeddingProfileName";
export { MODEL_DIGEST_PATTERN, fetchOllamaModelDigest } from "./search-chunk.fetchOllamaModelDigest";
