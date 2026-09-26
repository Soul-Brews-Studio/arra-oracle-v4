/** Shapes behind #33 AC3 -- "stale or unavailable evidence is visibly
 *  labelled" -- shared by the pure label functions (`captureStatusLabel`,
 *  `directEvidenceLabels`, `reverseEvidenceLabels`), the lookups that feed
 *  them (`resolveCitedRevisions`, `resolveCitingNodes`) and the badges that
 *  render them (`components/EvidenceBadges`).
 *
 * `pending` is its own tone, not a flavour of `ok`: a lookup that has not
 * landed yet must never read as "checked and fine". */
export type EvidenceTone = "ok" | "warn" | "bad" | "pending";

/** `text` is the short badge; `detail` says what the label is based on. */
export type EvidenceLabel = { text: string; tone: EvidenceTone; detail: string };

/** A live read of ONE cited `node_revision` target, keyed by the link's
 *  `target_key`. Absent from the map means the lookup has not landed. */
export type CitedRevisionStatus =
  | { kind: "not_checked"; reason: string }
  | { kind: "lookup_failed"; error: string }
  /** `getRevisionAssociations(node, rev)` answered `null`: no such revision on
   *  that node's accepted history in this workspace. */
  | { kind: "not_found" }
  | {
      kind: "resolved";
      isHead: boolean;
      headRevisionId: string;
      /** `null` when the recall-eligibility read itself failed. */
      eligible: boolean | null;
      eligibilityError: string | null;
    };

/** A live recall-eligibility read of ONE citing node, keyed by `node_id`. */
export type CitingNodeStatus =
  | { kind: "not_checked"; reason: string }
  | { kind: "lookup_failed"; error: string }
  | { kind: "resolved"; eligible: boolean };
