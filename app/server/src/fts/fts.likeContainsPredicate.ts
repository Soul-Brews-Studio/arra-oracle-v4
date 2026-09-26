/**
 * `column` contains `q` as literal text, case-insensitively, as a Lance SQL
 * filter: `column ILIKE '%q%' ESCAPE '\'`.
 *
 * `%`, `_` and the escape character itself are escaped first, then the single
 * quote is doubled for the SQL literal -- so a query of `50%`, `_b`, `O'` or a
 * lone backslash is matched as those characters, never as a wildcard or a
 * broken literal (each measured on 0.38.0). ILIKE, not LIKE: the trigram index
 * folds case, so the short-query fallback does too.
 *
 * `column` is a trusted identifier supplied by this server, never caller text.
 */
export function likeContainsPredicate(column: string, q: string): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/'/g, "''");
  return `${column} ILIKE '%${escaped}%' ESCAPE '\\'`;
}
