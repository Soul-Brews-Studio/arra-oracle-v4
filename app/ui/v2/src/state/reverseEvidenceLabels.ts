import type { DependentOccurrence } from "../api/evidenceReview";
import { captureStatusLabel } from "./captureStatusLabel";
import type { CitingNodeStatus, EvidenceLabel } from "./evidenceStatus.types";

/** Labels for one REVERSE-evidence occurrence -- some other node's revision
 *  that cites the selected one (#33 AC3).
 *
 * `scanDependents`' current mode means "each citing node's head", NOT
 * "active": association-evidence-v1 §4 -- "this evidence API does not invent
 * lifecycle filtering". So a citation from a retired or superseded node comes
 * back like any other, and only the citing node's recall eligibility (from
 * `citing`, keyed by `node_id`, filled by `resolveCitingNodes`) says whether
 * it still stands. `is_snapshot_head` is always true in current mode; it is
 * still labelled when false, so a history-mode page could never read as
 * current. */
export function reverseEvidenceLabels(
  occurrence: DependentOccurrence,
  citing: ReadonlyMap<string, CitingNodeStatus>,
): EvidenceLabel[] {
  const labels = [captureStatusLabel(occurrence.link)];
  if (!occurrence.is_snapshot_head) {
    labels.push({
      text: "historical citing revision",
      tone: "warn",
      detail: `rev ${occurrence.revision_no} is not the citing node's head any more`,
    });
  }
  const status = citing.get(occurrence.node_id);
  if (status === undefined) {
    labels.push({ text: "checking citing node…", tone: "pending", detail: "the citing node's lifecycle has not been read yet" });
  } else if (status.kind === "not_checked") {
    labels.push({ text: "citing node not checked", tone: "warn", detail: status.reason });
  } else if (status.kind === "lookup_failed") {
    labels.push({ text: "citing node status unknown", tone: "bad", detail: `lookup failed: ${status.error}` });
  } else if (!status.eligible) {
    labels.push({
      text: "citing node superseded/retired",
      tone: "warn",
      detail: "the citing node is no longer recall-eligible (getRecallEligibility)",
    });
  } else {
    labels.push({ text: "citing node current", tone: "ok", detail: "the citing node is recall-eligible" });
  }
  return labels;
}
