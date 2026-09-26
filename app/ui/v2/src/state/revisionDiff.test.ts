/** Failing-first tests for `revisionDiff` (#33 revision diff view).
 *
 * Pure logic, no DOM: `bun test src/state/revisionDiff.test.ts` from
 * `app/ui/v2`. Fixtures build the minimum `RevisionRow` shape the function
 * reads, matching the wire shape `api/knowledge.ts` documents (26 columns;
 * only the fields this diff touches are filled in here).
 */
import { describe, expect, test } from "bun:test";
import type { RevisionRow, TermSnapshot } from "../api/knowledge";
import { compareRevisionNo } from "./compareRevisionNo";
import { pairDiffLines } from "./pairDiffLines";
import { MAX_DIFF_CELLS, revisionDiff, type RevisionDiffResult } from "./revisionDiff";

/** `body` is a discriminated union (too-large bodies carry no `lines`); every
 *  test below builds SHORT bodies, so this just unwraps the `tooLarge:false`
 *  branch instead of repeating the narrowing at every call site. */
function linesOf(diff: RevisionDiffResult) {
  if (diff.body.tooLarge) throw new Error("expected a diffable body in this test");
  return diff.body.lines;
}

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
    expect(linesOf(diff)).toEqual([
      { op: "equal", text: "line one" },
      { op: "equal", text: "line two" },
    ]);
    expect(diff.termChanges).toEqual([]);
    expect(diff.linkChanges).toEqual([]);
    expect(diff.fieldChanges.every((c) => !c.changed)).toBe(true);
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
    expect(linesOf(diff)).toEqual([
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

/** Fix-round finding: revisionDiff compared only title/body/terms/links and
 *  silently reported "no difference" for a revision that only re-attributed
 *  authorship, changed session, expired validity or carried a different
 *  change_reason/fields -- exactly the shape #33's design revision-2 example
 *  needs ("distinct author/observer/subject"). Every field a revision
 *  request actually carries (contracts/revision-v1.ts) must be comparable,
 *  not just the free-text/set-shaped ones. */
describe("revisionDiff field-level diff", () => {
  test("reports every per-revision field, not just title/body/terms/links", () => {
    const a = revision({
      id: "r1",
      revision_no: "1",
      author_peer_name: "alice",
      observer_peer_name: null,
      subject_peer_name: "bob",
      session_name: "sess-a",
      is_active: true,
      valid_from: null,
      valid_to: null,
      change_reason: null,
      fields: "{}",
    });
    const b = revision({
      id: "r2",
      revision_no: "2",
      author_peer_name: "carol",
      observer_peer_name: null,
      subject_peer_name: "dave",
      session_name: "sess-b",
      is_active: true,
      valid_from: null,
      valid_to: "2026-10-01T00:00:00.000Z",
      change_reason: "re-attributed",
      fields: '{"k":1}',
    });
    const diff = revisionDiff(a, b);
    const byField = Object.fromEntries(diff.fieldChanges.map((c) => [c.field, c]));

    expect(byField.author_peer_name).toEqual({ field: "author_peer_name", changed: true, from: "alice", to: "carol" });
    expect(byField.observer_peer_name).toEqual({ field: "observer_peer_name", changed: false, from: null, to: null });
    expect(byField.subject_peer_name).toEqual({ field: "subject_peer_name", changed: true, from: "bob", to: "dave" });
    expect(byField.session_name).toEqual({ field: "session_name", changed: true, from: "sess-a", to: "sess-b" });
    expect(byField.is_active).toEqual({ field: "is_active", changed: false, from: "true", to: "true" });
    expect(byField.valid_from).toEqual({ field: "valid_from", changed: false, from: null, to: null });
    expect(byField.valid_to).toEqual({
      field: "valid_to",
      changed: true,
      from: null,
      to: "2026-10-01T00:00:00.000Z",
    });
    expect(byField.change_reason).toEqual({
      field: "change_reason",
      changed: true,
      from: null,
      to: "re-attributed",
    });
    expect(byField.fields).toEqual({ field: "fields", changed: true, from: "{}", to: '{"k":1}' });
  });

  test("a revision that ONLY expires validity (valid_to) is not reported as identical", () => {
    const a = revision({ id: "r1", revision_no: "1", valid_to: null });
    const b = revision({ id: "r2", revision_no: "2", valid_to: "2026-10-01T00:00:00.000Z" });
    const diff = revisionDiff(a, b);
    expect(diff.fieldChanges.some((c) => c.field === "valid_to" && c.changed)).toBe(true);
  });

  test("is_active flips render as a real boolean change, not a stringified no-op", () => {
    const a = revision({ id: "r1", revision_no: "1", is_active: true });
    const b = revision({ id: "r2", revision_no: "2", is_active: false });
    const diff = revisionDiff(a, b);
    expect(diff.fieldChanges.find((c) => c.field === "is_active")).toEqual({
      field: "is_active",
      changed: true,
      from: "true",
      to: "false",
    });
  });
});

/** Fix-round finding: `diffLines` builds a full (n+1)x(m+1) LCS table with no
 *  size guard, so `KnowledgeView` -- which renders this automatically for
 *  the two newest revisions of any node with 2+ revisions -- can freeze or
 *  crash the tab on a body inside the server's own 256 KiB request cap.
 *  `revisionDiff` must refuse to build the table past a bounded cell count
 *  and say so, rather than compute it. */
describe("revisionDiff body size guard", () => {
  test("MAX_DIFF_CELLS is a real, positive bound", () => {
    expect(MAX_DIFF_CELLS).toBeGreaterThan(0);
  });

  test("a body pair whose line-count product exceeds the bound reports tooLarge, not a computed table", () => {
    // n*m must exceed MAX_DIFF_CELLS while staying cheap to allocate in a
    // test: two bodies just over sqrt(MAX_DIFF_CELLS) lines each.
    const side = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1;
    const bodyA = Array.from({ length: side }, (_, i) => `line-${i}`).join("\n");
    const bodyB = Array.from({ length: side }, (_, i) => `LINE-${i}`).join("\n");
    const a = revision({ id: "r1", revision_no: "1", body: bodyA });
    const b = revision({ id: "r2", revision_no: "2", body: bodyB });
    const diff = revisionDiff(a, b);
    expect(diff.body).toEqual({ tooLarge: true, fromLineCount: side, toLineCount: side });
  });

  test("a body pair at or under the bound is still diffed normally", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "one\ntwo" });
    const b = revision({ id: "r2", revision_no: "2", body: "one\nTWO" });
    const diff = revisionDiff(a, b);
    expect(diff.body.tooLarge).toBe(false);
  });
});

describe("pairDiffLines", () => {
  test("pairs an adjacent removed+added run as one changed row, side by side", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "alpha\nbeta\ngamma" });
    const b = revision({ id: "r2", revision_no: "2", body: "alpha\nBETA\ngamma" });
    const rows = pairDiffLines(linesOf(revisionDiff(a, b)));
    expect(rows).toEqual([
      { kind: "equal", left: "alpha", right: "alpha" },
      { kind: "changed", left: "beta", right: "BETA" },
      { kind: "equal", left: "gamma", right: "gamma" },
    ]);
  });

  test("a line added with no counterpart has a blank left side", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "alpha" });
    const b = revision({ id: "r2", revision_no: "2", body: "alpha\nbeta" });
    const rows = pairDiffLines(linesOf(revisionDiff(a, b)));
    expect(rows).toEqual([
      { kind: "equal", left: "alpha", right: "alpha" },
      { kind: "added", left: null, right: "beta" },
    ]);
  });

  test("a line removed with no counterpart has a blank right side", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "alpha\nbeta" });
    const b = revision({ id: "r2", revision_no: "2", body: "alpha" });
    const rows = pairDiffLines(linesOf(revisionDiff(a, b)));
    expect(rows).toEqual([
      { kind: "equal", left: "alpha", right: "alpha" },
      { kind: "removed", left: "beta", right: null },
    ]);
  });
});

/** Fix-round 2 findings. (blocking) `pairDiffLines` mispaired every edit of
 *  two or more consecutive lines -- pinned here end to end, through the real
 *  LCS op stream, on the verifier's exact bodies. (nonblocking) the size guard
 *  ran BEFORE any equality check, so an unchanged 2,001-line body read "too
 *  large to diff" instead of "unchanged"; an empty body diffed as one removed
 *  empty line (`"".split("\n")` is `[""]`); and a term renamed between two
 *  revisions (same `term_id`, new name/label snapshot) read "no term changes",
 *  hiding exactly the label-snapshot history #33 asks the UI to render. */
describe("revisionDiff fix-round 2", () => {
  test("two consecutive edited lines pair in order through the real op stream", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "keep\nalpha\nbeta\nend" });
    const b = revision({ id: "r2", revision_no: "2", body: "keep\nALPHA\nBETA\nend" });
    expect(pairDiffLines(linesOf(revisionDiff(a, b)))).toEqual([
      { kind: "equal", left: "keep", right: "keep" },
      { kind: "changed", left: "alpha", right: "ALPHA" },
      { kind: "changed", left: "beta", right: "BETA" },
      { kind: "equal", left: "end", right: "end" },
    ]);
  });

  test("an unchanged body over the size bound is still reported line-equal, not too large", () => {
    const side = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1;
    const body = Array.from({ length: side }, (_, i) => `line-${i}`).join("\n");
    const a = revision({ id: "r1", revision_no: "1", body, author_peer_name: "alice" });
    const b = revision({ id: "r2", revision_no: "2", body, author_peer_name: "carol" });
    const diff = revisionDiff(a, b);
    expect(diff.body.tooLarge).toBe(false);
    const lines = linesOf(diff);
    expect(lines.length).toBe(side);
    expect(lines.every((l) => l.op === "equal")).toBe(true);
  });

  test("a large body with one edited line is diffed (common prefix/suffix are not in the table)", () => {
    const side = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1;
    const from = Array.from({ length: side }, (_, i) => `line-${i}`);
    const to = [...from];
    to[1000] = "EDITED";
    const a = revision({ id: "r1", revision_no: "1", body: from.join("\n") });
    const b = revision({ id: "r2", revision_no: "2", body: to.join("\n") });
    const lines = linesOf(revisionDiff(a, b));
    expect(lines.filter((l) => l.op !== "equal")).toEqual([
      { op: "removed", text: "line-1000" },
      { op: "added", text: "EDITED" },
    ]);
    expect(lines.length).toBe(side + 1);
  });

  test("an empty body has no lines: empty -> Thai is only added lines", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "" });
    const b = revision({ id: "r2", revision_no: "2", body: "ภาษาไทย\nบรรทัดสอง" });
    expect(linesOf(revisionDiff(a, b))).toEqual([
      { op: "added", text: "ภาษาไทย" },
      { op: "added", text: "บรรทัดสอง" },
    ]);
  });

  test("Thai -> empty body is only removed lines, and empty -> empty is no lines", () => {
    const a = revision({ id: "r1", revision_no: "1", body: "ภาษาไทย\nบรรทัดสอง" });
    const b = revision({ id: "r2", revision_no: "2", body: "" });
    expect(linesOf(revisionDiff(a, b))).toEqual([
      { op: "removed", text: "ภาษาไทย" },
      { op: "removed", text: "บรรทัดสอง" },
    ]);
    expect(linesOf(revisionDiff(b, b))).toEqual([]);
  });

  test("a term renamed between revisions (same term_id) is reported as relabelled", () => {
    const before = term("t-topic", "topic", "storage");
    const after = { ...before, term_name_snapshot: "storage_renamed" };
    const a = revision({ id: "r1", revision_no: "1", term_snapshot_json: JSON.stringify([before]) });
    const b = revision({ id: "r2", revision_no: "2", term_snapshot_json: JSON.stringify([after]) });
    expect(revisionDiff(a, b).termChanges).toEqual([{ change: "relabelled", from: before, term: after }]);
  });

  test("a changed label_snapshot alone is also a relabel", () => {
    const before = term("t-topic", "topic", "storage");
    const after = { ...before, label_snapshot: "ที่เก็บข้อมูล" };
    const a = revision({ id: "r1", revision_no: "1", term_snapshot_json: JSON.stringify([before]) });
    const b = revision({ id: "r2", revision_no: "2", term_snapshot_json: JSON.stringify([after]) });
    expect(revisionDiff(a, b).termChanges).toEqual([{ change: "relabelled", from: before, term: after }]);
  });
});

describe("compareRevisionNo", () => {
  test("orders numerically, descending, even past 2^53", () => {
    const values = ["2", "10", "9007199254740993", "1"];
    expect([...values].sort(compareRevisionNo)).toEqual(["9007199254740993", "10", "2", "1"]);
  });

  // Fix-round finding: the previous version of this test passed even if
  // `compareRevisionNo` used `Number(a) - Number(b)` instead of `BigInt`,
  // because none of its fixture values actually collide once rounded to a
  // JS `number`. These two DO collide -- `Number("9007199254740993") ===
  // Number("9007199254740992")` -- so a Number-based comparator cannot tell
  // them apart (and JS's default sort would then leave their relative order
  // unchanged, i.e. NOT descending), while `BigInt` orders them correctly.
  test("distinguishes two revision_no values that collide once rounded to a JS number", () => {
    expect(Number("9007199254740993")).toBe(Number("9007199254740992"));
    const values = ["9007199254740992", "9007199254740993"];
    expect([...values].sort(compareRevisionNo)).toEqual(["9007199254740993", "9007199254740992"]);
  });
});
