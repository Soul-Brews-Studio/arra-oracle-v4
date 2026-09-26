/**
 * Types shared by more than one function in the `search-chunk.*.ts` split. A
 * type used by exactly one function lives in that function's own file
 * instead.
 *
 * `EmbeddingProfileRequest` is produced by `embeddingProfile()` and also
 * appears as a field type on `IndexRevisionChunksRequest` (owned by
 * `search-chunk.parseIndexRevision.ts`), so it lives here rather than with
 * either.
 */
export type EmbeddingProfileRequest = { name: string; dims: number };

/**
 * The injected embedder `embedPendingChunks` calls OUTSIDE `core.serial`
 * (service.embedPendingChunks.ts's own header explains why). Same shape as
 * `embed.ts`'s `embed()`, plus an optional `AbortSignal` a real fetch-based
 * implementation can wire to its own request -- the timeout itself is
 * enforced by the caller via `Promise.race`, never by trusting an
 * implementation to honor the signal, so a test stub that ignores it entirely
 * still times out correctly.
 */
export type EmbedFn = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
