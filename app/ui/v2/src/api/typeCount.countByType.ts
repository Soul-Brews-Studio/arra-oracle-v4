import { type TypeTerm } from "./knowledge";
import { listNodes } from "./listing";
import { type Bank } from "./memory";
import { SAMPLE_LIMIT } from "./overview";
import { type TypeCount } from "./typeCount";

export async function countByType(b: Bank, term: TypeTerm, limit = SAMPLE_LIMIT): Promise<TypeCount> {
  const started = performance.now();
  // Sent as true even though the answer is a known null: the closed grammar
  // demands the key, and asking makes the by-design null distinguishable from
  // a count we simply declined to request. `include_inactive: false`: a
  // per-type count is about the ordinary, current view, same as the
  // unfiltered probe it is cross-checked against in `resolveByType`.
  const page = await listNodes(b, null, limit, true, term, false);
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
