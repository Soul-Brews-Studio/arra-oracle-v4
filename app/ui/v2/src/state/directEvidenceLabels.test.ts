/** Failing-first tests for the direct-evidence labels (#33 AC3: "stale or
 *  unavailable evidence is visibly labelled"; design revision 2: "unresolved
 *  evidence remain visible rather than fabricated").
 *
 * Fix-round 2 finding (blocking): `AssociationPanel` rendered only
 * `target_kind`, `relation` and the target JSON, never `capture_status`, so an
 * `unresolved` code citation looked identical to a `captured` one, and a
 * citation of a non-head revision of a superseded node carried no label.
 * Every label here comes from a field the API actually returns:
 *   - `capture_status` on the link row itself (`captured` / `locator_only` /
 *     `unresolved`, contracts/revision-v1.ts `CAPTURE_STATUSES`) -- a claim
 *     retained from citation time, not a live check (association-evidence-v1
 *     §3);
 *   - for a `node_revision` target only, a LIVE lookup of the cited revision
 *     (`getRevisionAssociations(node, rev)`: `null`, or `is_snapshot_head` +
 *     `snapshot_head_revision_id`) and its node (`getRecallEligibility`).
 */
import { describe, expect, test } from "bun:test";
import type { AssociationLinkRow } from "../api/evidenceReview";
import { directEvidenceLabels } from "./directEvidenceLabels";
import type { CitedRevisionStatus } from "./evidenceStatus.types";

function link(overrides: Partial<AssociationLinkRow>): AssociationLinkRow {
  return {
    workspace_name: "default",
    revision_id: "rev-citing",
    position: "0",
    relation: "supports",
    target_kind: "url",
    target: '{"url":"https://example.com"}',
    target_key: "key-url",
    excerpt: null,
    content_hash: null,
    captured_at: null,
    capture_status: "locator_only",
    note: null,
    ...overrides,
  };
}

const nodeRevLink = (key = "key-nr") =>
  link({
    relation: "derived_from",
    target_kind: "node_revision",
    target: '{"node_id":"node1aaaaaaaaaaaaaaaa","revision_id":"rev1aaaaaaaaaaaaaaaaa"}',
    target_key: key,
    capture_status: "captured",
    captured_at: "2026-09-26T10:00:00.000000Z",
  });

const texts = (labels: { text: string }[]) => labels.map((l) => l.text);

describe("directEvidenceLabels: capture status (every target kind)", () => {
  test("an unresolved citation is labelled unresolved, in the 'bad' tone", () => {
    const labels = directEvidenceLabels(link({ target_kind: "code", capture_status: "unresolved" }), new Map());
    expect(labels).toContainEqual(expect.objectContaining({ text: "unresolved", tone: "bad" }));
  });

  test("a locator-only citation is labelled locator only, in the 'warn' tone", () => {
    const labels = directEvidenceLabels(link({ capture_status: "locator_only" }), new Map());
    expect(labels).toContainEqual(expect.objectContaining({ text: "locator only", tone: "warn" }));
  });

  test("a captured citation is labelled captured, and its detail names the capture time", () => {
    const labels = directEvidenceLabels(
      link({ capture_status: "captured", captured_at: "2026-09-26T10:00:00.000000Z" }),
      new Map(),
    );
    const captured = labels.find((l) => l.text === "captured");
    expect(captured?.tone).toBe("ok");
    expect(captured?.detail).toContain("2026-09-26T10:00:00.000000Z");
  });

  test("a capture status this UI does not know is shown verbatim as a problem, not dropped", () => {
    const labels = directEvidenceLabels(link({ capture_status: "mystery" }), new Map());
    expect(labels).toContainEqual(expect.objectContaining({ tone: "bad" }));
    expect(texts(labels).join(" ")).toContain("mystery");
  });

  test("a non-node_revision target never claims a live target check", () => {
    const labels = directEvidenceLabels(link({ target_kind: "url", capture_status: "captured" }), new Map());
    expect(texts(labels)).toEqual(["captured"]);
  });
});

describe("directEvidenceLabels: node_revision targets (live lookup)", () => {
  const status = (s: CitedRevisionStatus) => new Map([["key-nr", s]]);

  test("before the lookup lands, the target reads as being checked -- never as current", () => {
    const labels = directEvidenceLabels(nodeRevLink(), new Map());
    expect(labels).toContainEqual(expect.objectContaining({ text: "checking target…", tone: "pending" }));
    expect(texts(labels)).not.toContain("current head");
  });

  test("a cited revision that is no longer its node's head is labelled stale, naming the head", () => {
    const labels = directEvidenceLabels(
      nodeRevLink(),
      status({ kind: "resolved", isHead: false, headRevisionId: "rev2bbbbbbbbbbbbbbbbb", eligible: true, eligibilityError: null }),
    );
    const stale = labels.find((l) => l.text === "stale: not head");
    expect(stale?.tone).toBe("warn");
    expect(stale?.detail).toContain("rev2bbbb");
  });

  test("a cited revision of a superseded/retired node is labelled so", () => {
    const labels = directEvidenceLabels(
      nodeRevLink(),
      status({ kind: "resolved", isHead: false, headRevisionId: "rev2bbbbbbbbbbbbbbbbb", eligible: false, eligibilityError: null }),
    );
    expect(texts(labels)).toContain("stale: not head");
    expect(labels).toContainEqual(expect.objectContaining({ text: "target superseded/retired", tone: "warn" }));
    expect(texts(labels)).not.toContain("current head");
  });

  test("a cited revision the server does not have on accepted history is labelled unavailable", () => {
    const labels = directEvidenceLabels(nodeRevLink(), status({ kind: "not_found" }));
    expect(labels).toContainEqual(expect.objectContaining({ text: "target unavailable", tone: "bad" }));
  });

  test("a failed lookup is labelled unknown with the error, never rendered as resolved", () => {
    const labels = directEvidenceLabels(nodeRevLink(), status({ kind: "lookup_failed", error: "forbidden" }));
    const unknown = labels.find((l) => l.text === "target status unknown");
    expect(unknown?.tone).toBe("bad");
    expect(unknown?.detail).toContain("forbidden");
  });

  test("a failed recall-eligibility read is labelled, not assumed eligible", () => {
    const labels = directEvidenceLabels(
      nodeRevLink(),
      status({ kind: "resolved", isHead: true, headRevisionId: "rev1aaaaaaaaaaaaaaaaa", eligible: null, eligibilityError: "HTTP 500" }),
    );
    expect(labels).toContainEqual(expect.objectContaining({ text: "target lifecycle unknown", tone: "bad" }));
    expect(texts(labels)).not.toContain("current head");
  });

  test("a target past the lookup cap is labelled not checked", () => {
    const labels = directEvidenceLabels(nodeRevLink(), status({ kind: "not_checked", reason: "only the first 32" }));
    expect(labels).toContainEqual(expect.objectContaining({ text: "target not checked", tone: "warn" }));
  });

  test("a cited head revision of an eligible node is labelled current head, and nothing else is flagged", () => {
    const labels = directEvidenceLabels(
      nodeRevLink(),
      status({ kind: "resolved", isHead: true, headRevisionId: "rev1aaaaaaaaaaaaaaaaa", eligible: true, eligibilityError: null }),
    );
    expect(texts(labels)).toEqual(["captured", "current head"]);
    expect(labels.every((l) => l.tone === "ok")).toBe(true);
  });
});
