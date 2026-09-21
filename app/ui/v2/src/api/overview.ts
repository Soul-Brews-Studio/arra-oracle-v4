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
import { type Page } from "./listing";

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

export const pendingCount = (method: string): Count => ({
  method, total: null, outcome: "pending", note: "not probed yet", durationMs: 0,
});

/** A counting probe asks for ONE row: `total` is a native COUNT over the whole
 *  scope and does not grow with `limit`, so paging for it is wasted bytes. */
const COUNT_LIMIT = 1;

/** Page size when the count AND the rows behind it are wanted -- the sessions
 *  and nodes cards read a subline off the page itself. Matches `useListing`'s
 *  PAGE_SIZE; all of these methods cap at 200. */
export const SAMPLE_LIMIT = 50;

type Fetch<T> = (limit: number, includeTotal: boolean) => Promise<Page<T>>;

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

/** One timed probe. `include_total` is always true, so on any 2xx the server
 *  answers with a decimal string; a null total therefore means the request did
 *  not succeed, which is what lets `failed` be told from a real zero without
 *  the HTTP status (`Page` deliberately drops it). That inference holds only
 *  while nothing filters the call -- filtered `listNodes` answers null by
 *  design, so route those through `countByType` instead.
 *
 * `terminal` hangs off the COUNT, not off the cursor. A failed request also
 * decodes to `nextCursor: null`, so reading the cursor alone answered "that
 * was the whole set" for a 401 and the sessions card printed "0 of — active"
 * under its own em dash. A page nobody received bounds nothing. */
export async function countWithSample<T>(
  method: string, fetch: Fetch<T>, limit = SAMPLE_LIMIT,
): Promise<Sample<T>> {
  const started = performance.now();
  const page = await fetch(limit, true);
  const durationMs = Math.round(performance.now() - started);
  if (!page.supported) {
    const note = `${method} is not on this server`;
    return { count: { method, total: null, outcome: "absent", note, durationMs }, rows: [], terminal: false };
  }
  if (page.total === null) {
    const note = `${method} did not answer with a count`;
    return { count: { method, total: null, outcome: "failed", note, durationMs }, rows: [], terminal: false };
  }
  const count: Count = { method, total: page.total, outcome: "counted", note: null, durationMs };
  return { count, rows: page.rows, terminal: page.nextCursor === null };
}

export async function countOnly<T>(method: string, fetch: Fetch<T>): Promise<Count> {
  return (await countWithSample(method, fetch, COUNT_LIMIT)).count;
}
