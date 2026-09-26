import { type DependentOccurrence, getRecallEligibility, recallEligibilityOf } from "../api/evidenceReview";
import type { Bank } from "../api/memory";
import { describeResult } from "./describeResult";
import type { CitingNodeStatus } from "./evidenceStatus.types";
import { MAX_STATUS_LOOKUPS } from "./resolveCitedRevisions";

/** Recall eligibility of every distinct node citing the selected revision,
 *  keyed by `node_id`. Feeds `reverseEvidenceLabels` (#33 AC3): current-mode
 *  `scanDependents` does not filter out retired or superseded citers, so
 *  this is the read that says whether a citation still stands. A failed or
 *  malformed read is `lookup_failed`, never assumed eligible. */
export async function resolveCitingNodes(
  b: Bank,
  occurrences: readonly DependentOccurrence[],
): Promise<Map<string, CitingNodeStatus>> {
  const nodeIds = [...new Set(occurrences.map((o) => o.node_id))];
  const out = new Map<string, CitingNodeStatus>();
  for (const id of nodeIds.slice(MAX_STATUS_LOOKUPS)) {
    out.set(id, { kind: "not_checked", reason: `only the first ${MAX_STATUS_LOOKUPS} citing nodes are checked` });
  }
  const checked = await Promise.all(
    nodeIds.slice(0, MAX_STATUS_LOOKUPS).map(async (id): Promise<readonly [string, CitingNodeStatus]> => {
      const result = await getRecallEligibility(b, id);
      if (!result.ok) return [id, { kind: "lookup_failed", error: describeResult(result) }];
      const verdict = recallEligibilityOf(result);
      if (verdict === null) return [id, { kind: "lookup_failed", error: "malformed recall eligibility response" }];
      return [id, { kind: "resolved", eligible: verdict.eligible }];
    }),
  );
  for (const [id, status] of checked) out.set(id, status);
  return out;
}
