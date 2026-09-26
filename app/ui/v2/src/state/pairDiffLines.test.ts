/** Failing-first tests for `pairDiffLines` (#33 side-by-side revision diff).
 *
 * Fix-round finding (blocking): the previous pairing looked only at the NEXT
 * op, so an edit of k >= 2 consecutive lines -- whose LCS op stream is k
 * removed ops followed by k added ops -- came out as k-1 removed rows, ONE
 * "changed" row pairing the LAST old line with the FIRST new line, then k-1
 * added rows. `keep/alpha/beta/end -> keep/ALPHA/BETA/end` rendered "beta
 * became ALPHA", which is false. These tests pin the pairing a side-by-side
 * reader expects: inside one hunk (a maximal run of non-equal ops), the i-th
 * removed line sits beside the i-th added line; whatever is left over on the
 * longer side is a plain removed or added row.
 *
 * Pure op streams, no RevisionRow needed: `bun test src/state/pairDiffLines.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { pairDiffLines, type PairedLine } from "./pairDiffLines";
import type { LineDiffOp } from "./revisionDiff";

const eq = (text: string): LineDiffOp => ({ op: "equal", text });
const rm = (text: string): LineDiffOp => ({ op: "removed", text });
const add = (text: string): LineDiffOp => ({ op: "added", text });

/** Reading ONE column of the side-by-side table top to bottom must give back
 *  that side's body, in order -- whatever the pairing, it may never reorder
 *  or drop a line. */
function column(rows: PairedLine[], side: "left" | "right"): string[] {
  return rows.flatMap((r) => (r[side] === null ? [] : [r[side]!]));
}

describe("pairDiffLines: consecutive changed lines", () => {
  test("two consecutive edited lines pair in order (the verifier's repro)", () => {
    const ops = [eq("keep"), rm("alpha"), rm("beta"), add("ALPHA"), add("BETA"), eq("end")];
    expect(pairDiffLines(ops)).toEqual([
      { kind: "equal", left: "keep", right: "keep" },
      { kind: "changed", left: "alpha", right: "ALPHA" },
      { kind: "changed", left: "beta", right: "BETA" },
      { kind: "equal", left: "end", right: "end" },
    ]);
  });

  test("three consecutive edited lines give three changed rows, no stray removed/added rows", () => {
    const ops = [rm("a"), rm("b"), rm("c"), add("A"), add("B"), add("C")];
    expect(pairDiffLines(ops)).toEqual([
      { kind: "changed", left: "a", right: "A" },
      { kind: "changed", left: "b", right: "B" },
      { kind: "changed", left: "c", right: "C" },
    ]);
  });

  test("a large all-different body is all changed rows, not one bogus pair among 2n-1 rows", () => {
    const n = 2000;
    const ops = [
      ...Array.from({ length: n }, (_, i) => rm(`old-${i}`)),
      ...Array.from({ length: n }, (_, i) => add(`new-${i}`)),
    ];
    const rows = pairDiffLines(ops);
    expect(rows.length).toBe(n);
    expect(rows.every((r) => r.kind === "changed")).toBe(true);
    expect(rows[0]).toEqual({ kind: "changed", left: "old-0", right: "new-0" });
    expect(rows[n - 1]).toEqual({ kind: "changed", left: `old-${n - 1}`, right: `new-${n - 1}` });
  });
});

describe("pairDiffLines: pure insertions and deletions", () => {
  test("a run of inserted lines is added rows with a blank left side", () => {
    const ops = [eq("a"), add("x"), add("y"), eq("b")];
    expect(pairDiffLines(ops)).toEqual([
      { kind: "equal", left: "a", right: "a" },
      { kind: "added", left: null, right: "x" },
      { kind: "added", left: null, right: "y" },
      { kind: "equal", left: "b", right: "b" },
    ]);
  });

  test("a run of deleted lines is removed rows with a blank right side", () => {
    const ops = [eq("a"), rm("x"), rm("y"), eq("b")];
    expect(pairDiffLines(ops)).toEqual([
      { kind: "equal", left: "a", right: "a" },
      { kind: "removed", left: "x", right: null },
      { kind: "removed", left: "y", right: null },
      { kind: "equal", left: "b", right: "b" },
    ]);
  });
});

describe("pairDiffLines: mixed hunks", () => {
  test("three removed + one added: the first pair is changed, the rest are removed", () => {
    const ops = [eq("k"), rm("r1"), rm("r2"), rm("r3"), add("a1"), eq("z")];
    expect(pairDiffLines(ops)).toEqual([
      { kind: "equal", left: "k", right: "k" },
      { kind: "changed", left: "r1", right: "a1" },
      { kind: "removed", left: "r2", right: null },
      { kind: "removed", left: "r3", right: null },
      { kind: "equal", left: "z", right: "z" },
    ]);
  });

  test("one removed + three added: the first pair is changed, the rest are added", () => {
    const ops = [rm("r1"), add("a1"), add("a2"), add("a3")];
    expect(pairDiffLines(ops)).toEqual([
      { kind: "changed", left: "r1", right: "a1" },
      { kind: "added", left: null, right: "a2" },
      { kind: "added", left: null, right: "a3" },
    ]);
  });

  test("an added op BEFORE a removed op in the same hunk still pairs them", () => {
    // The LCS backtrack can emit "added" first when that branch keeps a longer
    // common subsequence; the hunk is still one edit.
    const ops = [eq("k"), add("X"), rm("a"), eq("z")];
    expect(pairDiffLines(ops)).toEqual([
      { kind: "equal", left: "k", right: "k" },
      { kind: "changed", left: "a", right: "X" },
      { kind: "equal", left: "z", right: "z" },
    ]);
  });

  test("interleaved removed/added ops in one hunk pair by position on each side", () => {
    const ops = [rm("a"), add("X"), rm("b"), add("Y"), rm("c")];
    expect(pairDiffLines(ops)).toEqual([
      { kind: "changed", left: "a", right: "X" },
      { kind: "changed", left: "b", right: "Y" },
      { kind: "removed", left: "c", right: null },
    ]);
  });

  test("an equal line ends a hunk: nothing pairs across it", () => {
    const ops = [rm("a"), eq("k"), add("X")];
    expect(pairDiffLines(ops)).toEqual([
      { kind: "removed", left: "a", right: null },
      { kind: "equal", left: "k", right: "k" },
      { kind: "added", left: null, right: "X" },
    ]);
  });

  test("each column read top to bottom gives back its own side, in order", () => {
    const ops = [eq("k"), rm("r1"), add("a1"), rm("r2"), rm("r3"), add("a2"), eq("m"), add("a3"), rm("r4"), add("a4")];
    const rows = pairDiffLines(ops);
    expect(column(rows, "left")).toEqual(["k", "r1", "r2", "r3", "m", "r4"]);
    expect(column(rows, "right")).toEqual(["k", "a1", "a2", "m", "a3", "a4"]);
  });

  test("an empty op stream is an empty table", () => {
    expect(pairDiffLines([])).toEqual([]);
  });
});
