import type { LineDiffOp } from "./revisionDiff";

export type PairedLine = {
  kind: "equal" | "changed" | "added" | "removed";
  left: string | null;
  right: string | null;
};

/** `revisionDiff`'s body is a flat op stream (LCS order); `RevisionDiff.tsx`
 *  renders a SIDE-BY-SIDE table, which needs two lines per row, not one op
 *  per row.
 *
 * Pairing works per HUNK: a maximal run of non-equal ops between two equal
 * lines. Inside a hunk, the i-th removed line sits beside the i-th added
 * line (a "changed" row); whatever is left on the longer side becomes plain
 * removed or added rows. Each side keeps its own order, so reading one
 * column top to bottom always gives back that revision's body.
 *
 * Fix-round 2 finding (blocking): the previous version looked only at the
 * NEXT op, so an edit of k >= 2 consecutive lines (k removed ops, then k
 * added ops) became k-1 removed rows, one "changed" row pairing the LAST old
 * line with the FIRST new line, then k-1 added rows -- `keep/alpha/beta/end
 * -> keep/ALPHA/BETA/end` read "beta became ALPHA". Collecting the whole
 * hunk first also pairs an added op the LCS backtrack emitted BEFORE its
 * removed counterpart, which the next-op rule could never see. */
export function pairDiffLines(ops: LineDiffOp[]): PairedLine[] {
  const rows: PairedLine[] = [];
  let removed: string[] = [];
  let added: string[] = [];

  const flushHunk = () => {
    const paired = Math.min(removed.length, added.length);
    for (let k = 0; k < paired; k++) rows.push({ kind: "changed", left: removed[k]!, right: added[k]! });
    for (let k = paired; k < removed.length; k++) rows.push({ kind: "removed", left: removed[k]!, right: null });
    for (let k = paired; k < added.length; k++) rows.push({ kind: "added", left: null, right: added[k]! });
    removed = [];
    added = [];
  };

  for (const op of ops) {
    if (op.op === "equal") {
      flushHunk();
      rows.push({ kind: "equal", left: op.text, right: op.text });
    } else if (op.op === "removed") {
      removed.push(op.text);
    } else {
      added.push(op.text);
    }
  }
  flushHunk();
  return rows;
}
