/**
 * `q` as the body of a Lance SQL `LIKE`/`ILIKE` literal that matches `q`
 * itself, with `\` as the escape character: `%`, `_` and the escape character
 * are escaped first, then the single quote is doubled for the SQL literal. So
 * `50%`, `_b`, `O'` or a lone backslash match as those characters, never as a
 * wildcard or a broken literal (each measured on 0.38.0).
 *
 * Shared by every LIKE predicate this module builds, so they cannot escape
 * differently.
 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/'/g, "''");
}
