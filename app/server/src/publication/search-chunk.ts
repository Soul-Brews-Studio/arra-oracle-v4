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
 *    caller ever reaches the writer. See `./search-chunk/embedding-profile.ts`.
 * 2. `status` is `utf8 NOT NULL` with no enum in the physical schema. The
 *    closed set is this module's own decision, not a stored constraint --
 *    a differently-configured writer could legally store a fourth value,
 *    which is why the stored codec's status check is integrity_failure, not
 *    a request-grammar rejection. See `./search-chunk/stored-status.ts`.
 *
 * THIN BARREL: this file is now only a re-export surface. The implementation
 * lives one function per file under `./search-chunk/` -- see that directory
 * for the request grammar, deterministic id/content derivation, the chunker,
 * and the stored-row codec.
 */

export { EMBEDDING_DIMENSION } from "./search-chunk/embedding-profile";
export { CHUNKER_VERSION } from "./search-chunk/chunker-version";
export { CHUNK_SIZE_CHARS, chunkText } from "./search-chunk/chunk-text";
export { CHUNK_STATUSES, type ChunkStatus } from "./search-chunk/stored-status";
export { MAX_RECONCILE_REVISIONS, type ReconcileSearchChunksRequest, parseReconcileSearch } from "./search-chunk/parse-reconcile-search";
export { SEARCH_CHUNK_FIELDS, encodeSearchChunkRow } from "./search-chunk/encode-search-chunk-row";
export { type EmbeddingProfileRequest } from "./search-chunk/types";
export { type IndexRevisionChunksRequest, parseIndexRevision } from "./search-chunk/parse-index-revision";
export { type ListChunksRequest, parseListChunks } from "./search-chunk/parse-list-chunks";
export { SEARCH_CHUNK_ID_DOMAIN, deriveChunkId } from "./search-chunk/derive-chunk-id";
export { SEARCH_CHUNK_CONTENT_DOMAIN, deriveContentHash } from "./search-chunk/derive-content-hash";
