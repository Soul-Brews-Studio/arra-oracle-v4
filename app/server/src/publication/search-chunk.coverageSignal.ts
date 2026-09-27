/** Why an answer's candidate read may have left matches out. One reason
 *  today; a closed set, like `scan_reason`. */
export type CoverageReason = "candidate_ceiling";

/** The three closed fields every #30 search answer carries. */
export type CoverageSignal = {
  coverage: "full" | "partial";
  coverage_reason: CoverageReason | null;
  candidate_ceiling: number;
};

/**
 * #30 coverage (`search-chunk-v1.md` section 21, on overnight R22's "Known
 * residual", docs/overnight/DECISIONS.md): whether a search read EVERY
 * candidate it may answer from. `"partial"` with `"candidate_ceiling"` means
 * a candidate read came back holding `candidate_ceiling` rows, so more may
 * exist that were never read -- the answer may be incomplete, and for keyword
 * search which candidates were read may depend on the index every workspace
 * shares. `"full"` means no read reached the bound.
 *
 * Every read behind it is prefiltered to the requesting workspace, so the
 * flag is a function of that workspace's own rows: it never reflects another
 * workspace's counts. It carries no count and no score (R21), only the
 * bound, which is a server constant.
 */
export function coverageSignal(saturated: boolean, ceiling: number): CoverageSignal {
  return saturated
    ? { coverage: "partial", coverage_reason: "candidate_ceiling", candidate_ceiling: ceiling }
    : { coverage: "full", coverage_reason: null, candidate_ceiling: ceiling };
}
