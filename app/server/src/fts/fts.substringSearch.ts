import { MatchQuery, type Table } from "@lancedb/lancedb";
import {
  FTS_CANDIDATE_CEILING,
  FTS_CANDIDATE_FACTOR,
  FTS_MIN_QUERY_CODE_POINTS,
  type FtsResult,
} from "./fts.constants";
import { containsFolded } from "./fts.containsFolded";
import { likeContainsPredicate } from "./fts.likeContainsPredicate";

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

  let fetch = Math.max(limit, Math.min(limit * FTS_CANDIDATE_FACTOR, FTS_CANDIDATE_CEILING));
  for (;;) {
    const candidates: Row[] = await table
      .query()
      .fullTextSearch(new MatchQuery(q, column))
      .where(scope)
      .limit(fetch)
      .toArray();
    const rows = candidates.filter((row) => containsFolded(row[column], q));
    // Done when enough verified, when the index had nothing more to give, or
    // at the ceiling.
    if (rows.length >= limit || candidates.length < fetch || fetch >= FTS_CANDIDATE_CEILING) {
      return { match: "ngram", rows: rows.slice(0, limit) };
    }
    fetch = Math.min(fetch * 2, FTS_CANDIDATE_CEILING);
  }
}
