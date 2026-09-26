import { FTS_CANDIDATE_CEILING, FTS_CANDIDATE_FACTOR } from "./fts.constants";

/**
 * The ONE bounded overfetch loop behind every verified answer, legacy and
 * knowledge alike.
 *
 * `round(fetch)` asks its source for at most `fetch` candidates and returns
 * how many it actually got plus the ones that survived its own verification
 * (a substring re-check, a head-revision and eligibility check, a collapse of
 * chunks into nodes). The first fetch is `limit * FTS_CANDIDATE_FACTOR`; while
 * fewer than `limit` survive and the source filled the whole fetch, the fetch
 * doubles, never past `FTS_CANDIDATE_CEILING`. So an answer is short only
 * when the source ran dry or the ceiling was reached -- the bound is stated
 * in `fts.constants.ts`, not hidden here.
 *
 * Each round refetches from the top: the source's order (BM25, distance, or
 * a stated scan order) decides which candidates a round sees, never a cursor
 * this loop would have to keep consistent across rounds.
 */
export async function overfetch<Kept>(
  limit: number,
  round: (fetch: number) => Promise<{ fetched: number; kept: Kept[] }>,
): Promise<Kept[]> {
  let fetch = Math.max(limit, Math.min(limit * FTS_CANDIDATE_FACTOR, FTS_CANDIDATE_CEILING));
  for (;;) {
    const { fetched, kept } = await round(fetch);
    if (kept.length >= limit || fetched < fetch || fetch >= FTS_CANDIDATE_CEILING) return kept.slice(0, limit);
    fetch = Math.min(fetch * 2, FTS_CANDIDATE_CEILING);
  }
}
