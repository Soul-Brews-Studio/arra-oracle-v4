/** The pure mapping behind `<CoverageBadge>` (#85 / overnight ruling R4):
 *  "coverage means complete, not complete within what you may see".
 *
 * Pulled out of the component so the MEANING of `"full"` vs `"partial"` --
 * which text, which tone -- is one small function a test can pin without a
 * DOM, the same move `revisionDiff.ts` makes for the diff view. The
 * component stays a thin renderer of whatever this returns.
 */
import type { ContextResult } from "../api/memory";

export type CoverageBadgeView = {
  full: boolean;
  label: string;
  title: string;
};

const FULL_TITLE =
  "Nothing was excluded: every candidate was authorized and fit inside max_items, the wire budget and the linked-session bound.";
const PARTIAL_TITLE =
  "Something was left out: unauthorized evidence, a max_items or wire-budget stop, or linked sessions past the bound. The excluded list says which.";

export function coverageBadge(coverage: ContextResult["coverage"]): CoverageBadgeView {
  const full = coverage === "full";
  return {
    full,
    label: full ? "full coverage" : "partial coverage",
    title: full ? FULL_TITLE : PARTIAL_TITLE,
  };
}
