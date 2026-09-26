import type { AssociationLinkRow } from "../api/evidenceReview";
import { captureStatusLabel } from "./captureStatusLabel";
import type { CitedRevisionStatus, EvidenceLabel } from "./evidenceStatus.types";

const short = (id: string) => `${id.slice(0, 8)}…`;

/** Labels for one DIRECT-evidence link -- what the selected revision cites
 *  (#33 AC3; design revision 2: "unresolved evidence remain visible rather
 *  than fabricated").
 *
 * Always the link's own `capture_status`. For a `node_revision` target, also
 * the LIVE state of the cited revision from `cited` (keyed by `target_key`,
 * filled by `resolveCitedRevisions`): stale when a newer head exists,
 * superseded/retired when its node is no longer recall-eligible, unavailable
 * when the server has no such revision on accepted history. Every other
 * target kind (url, code, issue, ...) lives outside this dataset, so no
 * live claim is made for it at all -- only the capture claim is shown. */
export function directEvidenceLabels(
  link: AssociationLinkRow,
  cited: ReadonlyMap<string, CitedRevisionStatus>,
): EvidenceLabel[] {
  const labels = [captureStatusLabel(link)];
  if (link.target_kind !== "node_revision") return labels;

  const status = cited.get(link.target_key);
  if (status === undefined) {
    labels.push({ text: "checking target…", tone: "pending", detail: "the cited revision's current state has not been read yet" });
    return labels;
  }
  switch (status.kind) {
    case "not_checked":
      labels.push({ text: "target not checked", tone: "warn", detail: status.reason });
      return labels;
    case "lookup_failed":
      labels.push({ text: "target status unknown", tone: "bad", detail: `lookup failed: ${status.error}` });
      return labels;
    case "not_found":
      labels.push({
        text: "target unavailable",
        tone: "bad",
        detail: "no accepted revision with this id on that node in this workspace (getRevisionAssociations answered null)",
      });
      return labels;
    case "resolved": {
      const before = labels.length;
      if (!status.isHead) {
        labels.push({
          text: "stale: not head",
          tone: "warn",
          detail: `cites an older revision; that node's head is now ${short(status.headRevisionId)}`,
        });
      }
      if (status.eligible === false) {
        labels.push({
          text: "target superseded/retired",
          tone: "warn",
          detail: "the cited node is no longer recall-eligible (getRecallEligibility)",
        });
      } else if (status.eligible === null) {
        labels.push({
          text: "target lifecycle unknown",
          tone: "bad",
          detail: `recall eligibility could not be read: ${status.eligibilityError ?? "unknown error"}`,
        });
      }
      if (labels.length === before) {
        labels.push({ text: "current head", tone: "ok", detail: "the cited revision is still its node's head, and the node is recall-eligible" });
      }
      return labels;
    }
  }
}
