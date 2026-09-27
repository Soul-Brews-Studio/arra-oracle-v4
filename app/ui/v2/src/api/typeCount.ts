/** Per-type node counts -- the one count on this page the server will not do.
 *
 * Under `type_term` the kernel returns `total: null` ON PURPOSE: the type
 * lives inside a revision's `term_snapshot_json`, there is no native COUNT to
 * run over a JSON-embedded field, and it refuses to fake one. What is left is
 * counting rows, which `limit` bounds.
 *
 * Hence `atLeast`, not `count` -- a floor should read wrong at the call site
 * if printed as a total. `exact` marks the only condition under which the
 * floor IS the answer.
 */
import { type TypeTerm } from "./knowledge";

export type TypeCount = {
  term: TypeTerm;
  /** Rows counted under this term, and null when the call cannot be told from
   *  a failure -- see `resolveByType`. Never 0 for "we could not ask". */
  atLeast: number | null;
  exact: boolean;
  supported: boolean;
  note: string | null;
  durationMs: number;
};

// countByType / resolveByType moved out (style-ui-split,
// docs/overnight/DECISIONS.md): each lives in its own file named after
// itself. Re-exported here so importers (`state/useOverview.ts`) do not
// churn.
export { countByType } from "./typeCount.countByType";
export { resolveByType } from "./typeCount.resolveByType";
