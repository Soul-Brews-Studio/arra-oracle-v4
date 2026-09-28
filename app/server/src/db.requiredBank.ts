/**
 * The scope gate for the ORDINARY SCOPED READ HELPERS -- `list`, `searchText`,
 * `searchVector`, `getById` and `stats`. Enforced HERE, at the store boundary,
 * not by each caller remembering to pass a bank: an optional parameter that
 * silently dropped the predicate made an unscoped, cross-bank read a missing
 * argument away (#24). A non-string is refused rather than coerced, so a
 * runtime-bad value from an untyped seam cannot reach a predicate.
 *
 * Deliberately NOT applied to the low-level maintenance paths: `db()` opens the
 * table, `ensureFtsIndex` rebuilds an index, and `backfill` sweeps rows needing
 * vectors across the whole dataset by design. Those are not ordinary reads and
 * this gate is not a claim about them.
 *
 * An unknown but NONBLANK bank is a valid scope that simply matches nothing --
 * it returns empty, it does not throw.
 */
export function requiredBank(bank: unknown): string {
  if (typeof bank !== "string" || !bank.trim()) throw new Error("bank is required");
  return bank;
}
