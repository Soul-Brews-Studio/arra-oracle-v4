/**
 * After this many failed embed attempts a `search_chunks_v1` row stops being
 * retried by `embedPendingChunks` and stays `failed`. Matches `db.ts`'s
 * `MAX_SYNC_ATTEMPTS` for the legacy `memories` backfill exactly -- the same
 * "give up on a poison row" bound, applied to the same kind of loop.
 */
export const MAX_EMBED_ATTEMPTS = 5;
