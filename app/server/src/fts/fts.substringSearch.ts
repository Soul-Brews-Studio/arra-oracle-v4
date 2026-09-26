import { MatchQuery, type Table } from "@lancedb/lancedb";
import { FTS_MIN_QUERY_CODE_POINTS, type FtsResult } from "./fts.constants";
import { containsFolded } from "./fts.containsFolded";
import { likeContainsPredicate } from "./fts.likeContainsPredicate";
import { overfetch } from "./fts.overfetch";

type Row = Record<string, unknown>;

/**
 * Rows of `table` within `scope` whose `column` contains `q` (case-folded),
 * at most `limit`, and how they were found.
 *
 * - Under 3 code points (`[...q].length`, so Thai combining marks and astral
 *   characters count as the characters they are): a scoped, escaped ILIKE
 *   scan, `match: "substring_scan"`. Scan order, no score.
 * - Otherwise: the trigram index, `match: "ngram"`, BM25 order. Candidates
 *   are overfetched and each is re-checked as a literal substring before it
 *   is returned; see FTS_CANDIDATE_FACTOR/CEILING for the bound.
 *
 * The query goes in as a `MatchQuery`, never as a bare string: LanceDB parses
 * a bare string, and a double-quoted one becomes a phrase query that this
 * position-less index cannot serve (it throws; measured on pre-R14 code).
 *
 * `scope` is a trusted, already-quoted predicate built by the caller; it is
 * applied to both paths, so neither can answer outside it.
 */
export async function substringSearch(
  table: Pick<Table, "query">,
  column: string,
  q: string,
  scope: string,
  limit: number,
): Promise<FtsResult<Row>> {
  if ([...q].length < FTS_MIN_QUERY_CODE_POINTS) {
    const rows = await table
      .query()
      .where(`(${scope}) AND ${likeContainsPredicate(column, q)}`)
      .limit(limit)
      .toArray();
    return { match: "substring_scan", rows };
  }

  // Done when enough verified, when the index had nothing more to give, or at
  // the ceiling -- the shared loop in `fts.overfetch.ts`.
  const rows = await overfetch(limit, async (fetch) => {
    const candidates: Row[] = await table
      .query()
      .fullTextSearch(new MatchQuery(q, column))
      .where(scope)
      .limit(fetch)
      .toArray();
    return { fetched: candidates.length, kept: candidates.filter((row) => containsFolded(row[column], q)) };
  });
  return { match: "ngram", rows };
}
