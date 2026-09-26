/** Failing-first tests for `revisionDiff` (#33 revision diff view).
 *
 * Pure logic, no DOM: `bun test src/state/revisionDiff.test.ts` from
 * `app/ui/v2`. Fixtures build the minimum `RevisionRow` shape the function
 * reads, matching the wire shape `api/knowledge.ts` documents (26 columns;
 * only the fields this diff touches are filled in here).
 */
import { describe, expect, test } from "bun:test";
import type { RevisionRow, TermSnapshot } from "../api/knowledge";
import { compareRevisionNo, pairDiffLines, revisionDiff } from "./revisionDiff";

function term(term_id: string, vocabulary_name_snapshot: string, term_name_snapshot: string): TermSnapshot {
  return {
    term_id,
    vocabulary_id: `voc-${vocabulary_name_snapshot}`,
    vocabulary_name_snapshot,
    term_name_snapshot,
    label_snapshot: null,
    position: "0",
  };
}

function revision(overrides: Partial<RevisionRow> & { id: string; revision_no: string }): RevisionRow {
  return {
    node_id: "node-1",
    base_revision_id: null,
    operation_id: `op-${overrides.id}`,
    title: "untitled",
    body: "",
    body_format: "markdown",
    fields: "{}",
    author_peer_name: null,
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: null,
    is_active: true,
    valid_from: null,
    valid_to: null,
    change_reason: null,
    created_at: "2026-09-27T00:00:00.000Z",
    schema_version: "1",
    canonical_version: "arra-revision/v1",
    content_digest: `digest-${overrides.id}`,
    term_snapshot_json: "[]",
    link_snapshot_json: "[]",
    ...overrides,
  };
}

describe("revisionDiff", () => {
  test("reports no changes for two identical revisions", () => {
    const a = revision({ id: "r1", revision_no: "1", title: "Storage plan", body: "line one\nline two" });
    const b = revision({ id: "r1", revision_no: "1", title: "Storage plan", body: "line one\nline two" });
    const diff = revisionDiff(a, b);
    expect(diff.titleChanged).toBe(false);
    expect(diff.bodyLines).toEqual([
      { op: "equal", text: "line one" },
      { op: "equal", text: "line two" },
    ]);
    expect(diff.termChanges).toEqual([]);
    expect(diff.linkChanges).toEqual([]);
  });

  test("diffs a title change", () => {
    const a = revision({ id: "r1", revision_no: "1", title: "Storage plan" });
    const b = revision({ id: "r2", revision_no: "2", title: "Storage plan, revised" });
    const diff = revisionDiff(a, b);
    expect(diff.titleChanged).toBe(true);
    expect(diff.from.title).toBe("Storage plan");
    expect(diff.to.title).toBe("Storage plan, revised");
  });

  test("diffs body lines: one changed line reads as removed+added, not a full rewrite", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "alpha\nbeta\ngamma" });
    const b = revision({ id: "r2", revision_no: "2", body: "alpha\nBETA\ngamma" });
    const diff = revisionDiff(a, b);
    expect(diff.bodyLines).toEqual([
      { op: "equal", text: "alpha" },
      { op: "removed", text: "beta" },
      { op: "added", text: "BETA" },
      { op: "equal", text: "gamma" },
    ]);
  });

  test("reports an added term by term_id, ignoring position", () => {
    const typeNote = term("t-note", "type", "note");
    const horizon = term("t-short", "memory_horizon", "short_term");
    const a = revision({ id: "r1", revision_no: "1", term_snapshot_json: JSON.stringify([typeNote]) });
    const b = revision({
      id: "r2",
      revision_no: "2",
      term_snapshot_json: JSON.stringify([typeNote, horizon]),
    });
    const diff = revisionDiff(a, b);
    expect(diff.termChanges).toEqual([{ change: "added", term: horizon }]);
  });

  test("reports a removed term", () => {
    const typeNote = term("t-note", "type", "note");
    const horizon = term("t-short", "memory_horizon", "short_term");
    const a = revision({ id: "r1", revision_no: "1", term_snapshot_json: JSON.stringify([typeNote, horizon]) });
    const b = revision({ id: "r2", revision_no: "2", term_snapshot_json: JSON.stringify([typeNote]) });
    const diff = revisionDiff(a, b);
    expect(diff.termChanges).toEqual([{ change: "removed", term: horizon }]);
  });

  test("a term with an unchanged term_id but a different position is not a change", () => {
    const typeNote = term("t-note", "type", "note");
    const moved = { ...typeNote, position: "5" };
    const a = revision({ id: "r1", revision_no: "1", term_snapshot_json: JSON.stringify([typeNote]) });
    const b = revision({ id: "r2", revision_no: "2", term_snapshot_json: JSON.stringify([moved]) });
    expect(revisionDiff(a, b).termChanges).toEqual([]);
  });

  test("diffs added links by canonical entry text", () => {
    const link = { target_kind: "url", target: { url: "https://example.com" } };
    const a = revision({ id: "r1", revision_no: "1", link_snapshot_json: "[]" });
    const b = revision({ id: "r2", revision_no: "2", link_snapshot_json: JSON.stringify([link]) });
    const diff = revisionDiff(a, b);
    expect(diff.linkChanges).toEqual([{ change: "added", entry: link }]);
  });

  test("a missing link_snapshot_json reads as no links, not a crash", () => {
    const a = revision({ id: "r1", revision_no: "1" });
    delete (a as { link_snapshot_json?: string }).link_snapshot_json;
    const b = revision({ id: "r2", revision_no: "2" });
    expect(() => revisionDiff(a, b)).not.toThrow();
    expect(revisionDiff(a, b).linkChanges).toEqual([]);
  });
});

describe("pairDiffLines", () => {
  test("pairs an adjacent removed+added run as one changed row, side by side", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "alpha\nbeta\ngamma" });
    const b = revision({ id: "r2", revision_no: "2", body: "alpha\nBETA\ngamma" });
    const rows = pairDiffLines(revisionDiff(a, b).bodyLines);
    expect(rows).toEqual([
      { kind: "equal", left: "alpha", right: "alpha" },
      { kind: "changed", left: "beta", right: "BETA" },
      { kind: "equal", left: "gamma", right: "gamma" },
    ]);
  });

  test("a line added with no counterpart has a blank left side", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "alpha" });
    const b = revision({ id: "r2", revision_no: "2", body: "alpha\nbeta" });
    const rows = pairDiffLines(revisionDiff(a, b).bodyLines);
    expect(rows).toEqual([
      { kind: "equal", left: "alpha", right: "alpha" },
      { kind: "added", left: null, right: "beta" },
    ]);
  });

  test("a line removed with no counterpart has a blank right side", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "alpha\nbeta" });
    const b = revision({ id: "r2", revision_no: "2", body: "alpha" });
    const rows = pairDiffLines(revisionDiff(a, b).bodyLines);
    expect(rows).toEqual([
      { kind: "equal", left: "alpha", right: "alpha" },
      { kind: "removed", left: "beta", right: null },
    ]);
  });
});

describe("compareRevisionNo", () => {
  test("orders numerically, descending, even past 2^53", () => {
    const values = ["2", "10", "9007199254740993", "1"];
    expect([...values].sort(compareRevisionNo)).toEqual(["9007199254740993", "10", "2", "1"]);
  });
});
