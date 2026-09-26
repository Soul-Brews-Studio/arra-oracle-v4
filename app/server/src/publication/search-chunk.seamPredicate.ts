import { likePrefixPredicate } from "../fts/fts.likePrefixPredicate";

/**
 * The chunks that could hold the TAIL of an occurrence of `query` cut by a
 * chunk boundary: a non-first chunk (`chunk_index > 0`) that starts with a
 * proper suffix of the query, one clause per cut position, case-insensitive
 * and escaped (`likePrefixPredicate`). `null` for a one-code-point query,
 * which no boundary can cut (`chunkText` never splits a surrogate pair).
 *
 * Complete for a query that spans at most two chunks -- any query shorter
 * than a chunk -- since the chunk after the cut begins with the rest of the
 * occurrence. It over-selects (a chunk may start with those letters by
 * chance); the caller re-checks every hit against the whole head text. Its
 * size grows with the square of the query, so callers use it for short
 * queries only.
 */
export function seamPredicate(query: string): string | null {
  const points = [...query];
  if (points.length < 2) return null;
  const clauses = points.slice(1).map((_, i) => likePrefixPredicate("text", points.slice(i + 1).join("")));
  return `(chunk_index > 0 AND (${clauses.join(" OR ")}))`;
}
