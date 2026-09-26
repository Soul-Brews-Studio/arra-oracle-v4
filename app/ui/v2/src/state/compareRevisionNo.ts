/** `revision_no` is Int64 wire text (see `api/knowledge.ts` note 2) -- it can
 *  exceed `Number.MAX_SAFE_INTEGER` in principle, so a picker sorting
 *  revisions for the diff view compares via `BigInt`, not `Number(...)`,
 *  the same precision rule `RevisionHistory`'s neighbours already follow.
 *  Descending, newest first -- what a "pick two revisions to compare" list
 *  wants to show on top. */
export function compareRevisionNo(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  if (x === y) return 0;
  return x > y ? -1 : 1;
}
