import type { LineDiffOp } from "./revisionDiff";

export type PairedLine = {
  kind: "equal" | "changed" | "added" | "removed";
  left: string | null;
  right: string | null;
};

/** `bodyLines` is a flat op stream (LCS order); `RevisionDiff.tsx` renders a
 *  SIDE-BY-SIDE table, which needs two lines per row, not one op per row. An
 *  adjacent removed-then-added run is exactly what a single edited line
 *  produces (see `diffLines`'s tie-break), so it collapses to one "changed"
 *  row instead of a removed row stacked over an unrelated added row -- the
 *  pairing a reader's eye already expects from "this line became that one". */
export function pairDiffLines(ops: LineDiffOp[]): PairedLine[] {
  const rows: PairedLine[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    const next = ops[i + 1];
    if (op.op === "equal") {
      rows.push({ kind: "equal", left: op.text, right: op.text });
      i++;
    } else if (op.op === "removed" && next?.op === "added") {
      rows.push({ kind: "changed", left: op.text, right: next.text });
      i += 2;
    } else if (op.op === "removed") {
      rows.push({ kind: "removed", left: op.text, right: null });
      i++;
    } else {
      rows.push({ kind: "added", left: null, right: op.text });
      i++;
    }
  }
  return rows;
}
