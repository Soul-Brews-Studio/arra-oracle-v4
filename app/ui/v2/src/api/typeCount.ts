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
import { listNodes } from "./listing";
import { type Bank } from "./memory";
import { type Count, SAMPLE_LIMIT } from "./overview";

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

export async function countByType(b: Bank, term: TypeTerm, limit = SAMPLE_LIMIT): Promise<TypeCount> {
  const started = performance.now();
  // Sent as true even though the answer is a known null: the closed grammar
  // demands the key, and asking makes the by-design null distinguishable from
  // a count we simply declined to request.
  const page = await listNodes(b, null, limit, true, term);
  const durationMs = Math.round(performance.now() - started);
  const exact = page.supported && page.nextCursor === null;
  const empty = exact && page.rows.length === 0;
  const note = !page.supported
    ? "listNodes is not on this server"
    : empty
      ? `no ${term} nodes came back, and a filtered call carries no total -- only the unfiltered count tells this from a failure`
      : exact
        ? null
        : `a floor: more than ${limit} nodes are typed ${term}, and a filtered call carries no total`;
  return { term, atLeast: page.rows.length, exact, supported: page.supported, note, durationMs };
}

const UNMEASURED =
  "not counted: the unfiltered listNodes in the same volley did not answer either, so an empty filtered page here is a failed call rather than a count";

/** The cross-read this module used to only DESCRIBE, now performed.
 *
 * With no total in a filtered response, an empty page and a 401 decode to the
 * same three fields, so `countByType` alone cannot tell them apart and used
 * to call the failure `exact` -- which is how five cells printed a confident
 * `0` while the probe ledger beside them said "no answer". The unfiltered
 * probe in the same volley is the tiebreaker: same method, same credential,
 * same server, fired together. If that one did not come back with a count,
 * neither did these, and their zeros are unknowns. */
export function resolveByType(byType: TypeCount[], unfiltered: Count): TypeCount[] {
  if (unfiltered.outcome === "counted") return byType;
  // An absent method keeps its own note: "not on this server" is a sharper
  // answer than "we could not tell", and it is already correct.
  return byType.map((t) => (t.supported ? { ...t, atLeast: null, exact: false, note: UNMEASURED } : t));
}
