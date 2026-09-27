import { FTS_CANDIDATE_CEILING, FTS_CANDIDATE_FACTOR } from "./fts.constants";

/**
 * `overfetch`'s loop, also answering whether it stopped AT the bound (#30
 * coverage, `search-chunk-v1.md` section 21): `saturated` is true when the
 * last round asked for `ceiling` candidates, got that many, and still fewer
 * than `limit` survived. Only then may a match lie past what was read. An
 * answer short because the source ran dry, or one that reached `limit`, is
 * not saturated.
 *
 * `ceiling` is `FTS_CANDIDATE_CEILING` in production; only tests pass
 * another, so a handful of rows can stand for 4096.
 */
export async function overfetchCoverage<Kept>(
  limit: number,
  round: (fetch: number) => Promise<{ fetched: number; kept: Kept[] }>,
  ceiling: number = FTS_CANDIDATE_CEILING,
): Promise<{ kept: Kept[]; saturated: boolean }> {
  let fetch = Math.max(limit, Math.min(limit * FTS_CANDIDATE_FACTOR, ceiling));
  for (;;) {
    const { fetched, kept } = await round(fetch);
    if (kept.length >= limit || fetched < fetch || fetch >= ceiling) {
      return { kept: kept.slice(0, limit), saturated: kept.length < limit && fetched >= fetch && fetch >= ceiling };
    }
    fetch = Math.min(fetch * 2, ceiling);
  }
}
