import { type Bank } from "./memory";
import { type NodeRevisionTarget, type DependentsCursor } from "./evidenceReview";
import { call } from "./evidenceReview.call";

/** `revision_mode: "current"` -- dependents scoped to what OTHER nodes'
 *  captured heads cite right now, matching how `getRecallEligibility` and
 *  the rest of this review surface already read "current" state rather than
 *  full history. `"history"` exists in the kernel but is not exposed here:
 *  the brief asks for direct/reverse evidence, not a history-mode toggle. */
export const scanDependents = (
  b: Bank,
  target: NodeRevisionTarget,
  limit: number,
  cursor: DependentsCursor | null,
) =>
  call(b, "scanDependents", {
    target_kind: "node_revision",
    target,
    revision_mode: "current",
    limit,
    cursor,
  });
