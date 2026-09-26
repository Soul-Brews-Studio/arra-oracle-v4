/** Failing-first tests for the reverse-evidence labels (#33 AC3, fix-round 2).
 *
 * `DependentsPanel` listed every citing occurrence as if it were live and
 * resolved. An occurrence carries its own `link.capture_status` and
 * `is_snapshot_head`, and `scanDependents`' current mode means "head", NOT
 * "active": association-evidence-v1 §4 says it "does not invent lifecycle
 * filtering", so a retired or superseded citing node is returned like any
 * other. Its recall eligibility (`getRecallEligibility` on the citing node) is
 * the one extra read that says whether the citation still stands.
 */
import { describe, expect, test } from "bun:test";
import type { AssociationLinkRow, DependentOccurrence } from "../api/evidenceReview";
import type { CitingNodeStatus } from "./evidenceStatus.types";
import { reverseEvidenceLabels } from "./reverseEvidenceLabels";

function occurrence(linkOverrides: Partial<AssociationLinkRow> = {}, isHead = true): DependentOccurrence {
  return {
    workspace_name: "default",
    node_id: "node3ccccccccccccccccc",
    revision_id: "rev3ccccccccccccccccc",
    revision_no: "1",
    content_digest: "d",
    snapshot_head_revision_id: isHead ? "rev3ccccccccccccccccc" : "rev4ddddddddddddddddd",
    is_snapshot_head: isHead,
    link: {
      workspace_name: "default",
      revision_id: "rev3ccccccccccccccccc",
      position: "0",
      relation: "derived_from",
      target_kind: "node_revision",
      target: '{"node_id":"node1aaaaaaaaaaaaaaaa","revision_id":"rev1aaaaaaaaaaaaaaaaa"}',
      target_key: "key-nr",
      excerpt: null,
      content_hash: null,
      captured_at: null,
      capture_status: "captured",
      note: null,
      ...linkOverrides,
    },
  };
}

const citing = (s: CitingNodeStatus) => new Map([["node3ccccccccccccccccc", s]]);
const texts = (labels: { text: string }[]) => labels.map((l) => l.text);

describe("reverseEvidenceLabels", () => {
  test("the citing link's own capture status is labelled", () => {
    const labels = reverseEvidenceLabels(occurrence({ capture_status: "unresolved" }), new Map());
    expect(labels).toContainEqual(expect.objectContaining({ text: "unresolved", tone: "bad" }));
  });

  test("a citing node that has been superseded or retired is labelled so", () => {
    const labels = reverseEvidenceLabels(occurrence(), citing({ kind: "resolved", eligible: false }));
    expect(labels).toContainEqual(expect.objectContaining({ text: "citing node superseded/retired", tone: "warn" }));
    expect(texts(labels)).not.toContain("citing node current");
  });

  test("before the citing node's lookup lands, it reads as being checked -- never as current", () => {
    const labels = reverseEvidenceLabels(occurrence(), new Map());
    expect(labels).toContainEqual(expect.objectContaining({ text: "checking citing node…", tone: "pending" }));
  });

  test("a failed lookup is labelled unknown with its error", () => {
    const labels = reverseEvidenceLabels(occurrence(), citing({ kind: "lookup_failed", error: "forbidden" }));
    const unknown = labels.find((l) => l.text === "citing node status unknown");
    expect(unknown?.tone).toBe("bad");
    expect(unknown?.detail).toContain("forbidden");
  });

  test("a citing node past the lookup cap is labelled not checked", () => {
    const labels = reverseEvidenceLabels(occurrence(), citing({ kind: "not_checked", reason: "cap" }));
    expect(labels).toContainEqual(expect.objectContaining({ text: "citing node not checked", tone: "warn" }));
  });

  test("an occurrence from a non-head citing revision (history mode) is labelled historical", () => {
    const labels = reverseEvidenceLabels(occurrence({}, false), citing({ kind: "resolved", eligible: true }));
    expect(labels).toContainEqual(expect.objectContaining({ text: "historical citing revision", tone: "warn" }));
  });

  test("a captured citation from a current, eligible head is all ok", () => {
    const labels = reverseEvidenceLabels(occurrence(), citing({ kind: "resolved", eligible: true }));
    expect(texts(labels)).toEqual(["captured", "citing node current"]);
    expect(labels.every((l) => l.tone === "ok")).toBe(true);
  });
});
