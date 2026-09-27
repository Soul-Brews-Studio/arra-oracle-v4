import { type Count } from "./overview";
import { type TypeCount } from "./typeCount";

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
