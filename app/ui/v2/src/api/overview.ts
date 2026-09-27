/** The COUNTING half of the API -- every number the overview page shows.
 *
 * `listing.ts` wraps the three enumeration methods EXPLORE walks page by page
 * and `audit.ts` wraps the two audit-tier ones; both are imported by callers,
 * never re-implemented here. This file adds the "ask for the count, skip the
 * rows" shape an overview needs, and the per-type variant lives beside it in
 * `typeCount.ts`.
 *
 * Two rules give the module its shape. A count is the server's canonical
 * decimal TEXT, verbatim -- Int64 can exceed 2^53, so `Number(total)` is the
 * precision bug `knowledge.ts` warns about for `position`. And `null` is never
 * `0`, nor one thing: "not asked", "the call failed, retry" and "this build has
 * no such method, retrying will not help" lead a reader to three different
 * actions, so `Count.outcome` keeps them apart. `listing.ts` already computes
 * the third as `Page.supported` and drops it at the component boundary.
 */
export type CountOutcome =
  | "pending" /* never asked -- nothing has probed yet */
  | "counted" /* `total` is the server's own decimal string */
  | "failed" /* the call ran and did not answer; retrying may help */
  | "absent"; /* the method is not on this build; retrying will not help */

export type Count = {
  method: string;
  /** The wire value VERBATIM, and null unless `outcome === "counted"`. */
  total: string | null;
  outcome: CountOutcome;
  /** One phrase, for the title a dash or a greyed-out card hangs off. */
  note: string | null;
  durationMs: number;
};

/** Page size when the count AND the rows behind it are wanted -- the sessions
 *  and nodes cards read a subline off the page itself. Matches `useListing`'s
 *  PAGE_SIZE; all of these methods cap at 200. */
export const SAMPLE_LIMIT = 50;

export type Sample<T> = {
  count: Count;
  rows: T[];
  /** True when this page held the WHOLE set, and we KNOW it did. Anything
   *  derived from `rows` -- "3 of 5 active", a revision sum -- is a claim
   *  about the PAGE, and becomes a claim about the set only when this is
   *  true, so false is the answer for every doubt including "the request
   *  never landed". */
  terminal: boolean;
};

// pendingCount / countWithSample / countOnly moved out (style-ui-split,
// docs/overnight/DECISIONS.md): each lives in its own file named after
// itself. Re-exported here so importers (`state/useOverview.ts`) do not
// churn.
export { pendingCount } from "./overview.pendingCount";
export { countWithSample } from "./overview.countWithSample";
export { countOnly } from "./overview.countOnly";
