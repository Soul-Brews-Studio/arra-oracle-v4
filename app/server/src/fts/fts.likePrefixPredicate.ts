import { escapeLike } from "./fts.escapeLike";

/**
 * `column` STARTS WITH `q` as literal text, case-insensitively, as a Lance SQL
 * filter: `column ILIKE 'q%' ESCAPE '\'`. Escaped exactly like
 * `likeContainsPredicate` (`escapeLike`); ILIKE for the same reason.
 *
 * `column` is a trusted identifier supplied by this server, never caller text.
 */
export function likePrefixPredicate(column: string, q: string): string {
  return `${column} ILIKE '${escapeLike(q)}%' ESCAPE '\\'`;
}
