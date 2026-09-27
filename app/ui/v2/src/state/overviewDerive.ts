/** The pure half of the overview state: everything computed FROM a finished
 *  volley, with no fetching and no React in it.
 *
 * Split from `useOverview.ts` because these are the functions that decide
 * what is known and what merely looks known -- the subtlest code on the page,
 * and the part worth reading without a hook wrapped around it.
 *
 * One rule runs through all of them: a derivation over rows that were never
 * returned is null, not zero. Every function here takes the probe's outcome
 * as well as its rows, because the rows alone cannot say whether they are a
 * sample, the whole set, or the empty array a failed request decodes to.
 */
export type HealthInfo = { ok: boolean; version: string | null; auth: string | null; durationMs: number };

/** Sublines computed over the RETURNED PAGE, never by the server -- so both go
 *  null the moment the set did not fit on one page, rather than quietly
 *  describing the first fifty rows as if they were all of them. */
export type PageDerived = { activeSessions: number | null; revisions: string | null };

/** The mock's `Σ 5 = nodes total ✓`. Two independent measurements of the same
 *  set, so checking them against each other is free evidence -- and when they
 *  cannot be compared (no total, no sum, or any floor among the parts) that is
 *  `null` rather than `false`: "not checkable" is not "disagrees". */
export type ByTypeCheck = { sum: number | null; allExact: boolean; matchesTotal: boolean | null };

// derivePage / deriveByTypeCheck / toHealth moved out (style-ui-split,
// docs/overnight/DECISIONS.md): each lives in its own file named after
// itself. Re-exported here so importers (`overview/ProbeTable.tsx`,
// `state/useOverview.ts`) do not churn.
export { derivePage } from "./overviewDerive.derivePage";
export { deriveByTypeCheck } from "./overviewDerive.deriveByTypeCheck";
export { toHealth } from "./overviewDerive.toHealth";
