/**
 * Field-for-field equality for one ENCODED wire value, array-aware.
 *
 * Every other readback comparison in this file compares scalar wire fields
 * with `!==`, which is correct for them -- none of their encoded values is an
 * array. `search_chunks_v1.term_ids` is: a bare `!==` would compare two
 * distinct array references and never agree, which is not what "the row
 * holds what was asked for" means for a list column.
 */
export function sameEncodedValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return a === b;
}
