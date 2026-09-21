/**
 * Types shared by more than one function in this directory. A type used by
 * exactly one function lives in that function's own file instead.
 *
 * `EmbeddingProfileRequest` is produced by `embeddingProfile()` and also
 * appears as a field type on `IndexRevisionChunksRequest` (owned by
 * `parse-index-revision.ts`), so it lives here rather than with either.
 */
export type EmbeddingProfileRequest = { name: string; dims: number };
