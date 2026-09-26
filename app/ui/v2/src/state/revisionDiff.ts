/** A pure, field-level diff between two accepted revisions of the same node.
 *
 * #33 asks for "two accepted revisions of a node side by side, field-level
 * diff". `listAcceptedHistory` and `getAcceptedHead` already return every
 * field this needs (measured: 26 columns, see `api/knowledge.ts`), so this
 * file does no fetching -- it only compares two `RevisionRow`s already in
 * memory. Kept pure and DOM-free on purpose: `revisionDiff.test.ts` runs it
 * with `bun test`, no browser required, the same discipline `roster.ts`'s
 * pure helpers already follow.
 *
 * Four independent comparisons, because the fields disagree about what
 * "changed" means:
 *   - `title`/`body`  -- free text, diffed line by line (LCS-based, the
 *     textbook algorithm -- there is no existing diff dependency in this
 *     POC and the hard rule for this slice is "no new dependencies").
 *   - every OTHER per-revision request field (`author_peer_name`,
 *     `observer_peer_name`, `subject_peer_name`, `session_name`,
 *     `is_active`, `valid_from`, `valid_to`, `change_reason`, `fields` --
 *     see `contracts/revision-v1.ts`'s request fields) -- a plain
 *     from/to/changed comparison per field. Fix-round finding: an earlier
 *     version of this file compared only title/body/terms/links, so a
 *     revision whose ONLY change was re-attributing authorship or expiring
 *     `valid_to` read as "no difference" -- exactly the case #33's design
 *     revision-2 example needs ("distinct author/observer/subject") and
 *     the one thing a lifecycle-review reader most needs to see.
 *   - `term_snapshot_json` -- a small SET of terms, keyed by `term_id`
 *     (the stable identity a term snapshot carries); a term is either
 *     present or not, so this is a set difference, not a line diff.
 *   - `link_snapshot_json` -- likewise a set, keyed by the whole canonical
 *     JSON text of one entry (the evidence codec already canonicalizes it,
 *     so byte-equal text IS the identity check here -- see
 *     `session-link.ts`'s `evidenceRefText` for the same move on the
 *     server side).
 */
import type { RevisionRow, TermSnapshot } from "../api/knowledge";
import { parseTerms } from "../api/knowledge";

export type LineDiffOp = { op: "equal" | "added" | "removed"; text: string };

export type TermChange = { change: "added" | "removed"; term: TermSnapshot };

export type LinkChange = { change: "added" | "removed"; entry: unknown };

/** Every per-revision request field this diff can compare besides
 *  title/body/terms/links -- see `PublishInput`/`RevisionRow` in
 *  `api/knowledge.ts` and contracts/revision-v1.ts §"content" for why this
 *  exact list is complete: it is every field a `publishRevision` request
 *  carries that is not already covered by one of the other three
 *  comparisons above. */
export const FIELD_KEYS = [
  "author_peer_name",
  "observer_peer_name",
  "subject_peer_name",
  "session_name",
  "is_active",
  "valid_from",
  "valid_to",
  "change_reason",
  "fields",
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/** `from`/`to` are always rendered as text (or `null`): `is_active` is the
 *  one boolean in this set, stringified so the UI has one shape to render
 *  regardless of which field it is showing, not a special case per type. */
export type FieldChange = { field: FieldKey; changed: boolean; from: string | null; to: string | null };

function fieldText(revision: RevisionRow, field: FieldKey): string | null {
  const value = revision[field];
  if (value === null) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

function diffFields(from: RevisionRow, to: RevisionRow): FieldChange[] {
  return FIELD_KEYS.map((field) => {
    const a = fieldText(from, field);
    const b = fieldText(to, field);
    return { field, changed: a !== b, from: a, to: b };
  });
}

/** n*m LCS table cells this diff will build before it refuses. Fix-round
 *  finding: `diffLines` had no size guard, and `KnowledgeView` renders it
 *  automatically for the two newest revisions of any node with 2+
 *  revisions -- a body well inside the server's own 256 KiB request cap
 *  (`auth/http.ts` `MAX_BODY_BYTES`) could freeze or crash the tab, because
 *  the table is quadratic in line count. Measured under Bun (fix-round
 *  finding, same-length bodies differing on every line): 2,000 lines
 *  (4,000,000 cells) ~27ms/~73MB; 5,000 lines (25,000,000 cells)
 *  ~183ms/~247MB; 10,000 lines (100,000,000 cells) ~776ms/~865MB. This
 *  bound sits at the low end of that measured range on purpose. */
export const MAX_DIFF_CELLS = 4_000_000;

export type BodyDiffResult =
  | { tooLarge: false; lines: LineDiffOp[] }
  | { tooLarge: true; fromLineCount: number; toLineCount: number };

export type RevisionDiffResult = {
  from: Pick<RevisionRow, "id" | "revision_no" | "title">;
  to: Pick<RevisionRow, "id" | "revision_no" | "title">;
  titleChanged: boolean;
  bodyFormatChanged: boolean;
  fieldChanges: FieldChange[];
  body: BodyDiffResult;
  termChanges: TermChange[];
  linkChanges: LinkChange[];
};

/** Classic O(n*m) LCS over lines, then a backtrack that emits one op per
 *  line. Bodies in this app are short (POC content, not imported corpora),
 *  so the quadratic table is the right trade for "no new dependency" over
 *  a faster streaming algorithm -- PROVIDED the caller has already checked
 *  `n*m` against `MAX_DIFF_CELLS` (see `diffBody`, the only caller): this
 *  function itself does not guard, so it must never be called directly on
 *  unbounded input. */
function diffLines(a: string[], b: string[]): LineDiffOp[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: LineDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: "equal", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ op: "removed", text: a[i]! });
      i++;
    } else {
      ops.push({ op: "added", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ op: "removed", text: a[i++]! });
  while (j < m) ops.push({ op: "added", text: b[j++]! });
  return ops;
}

/** The size-guarded entry point for the body diff: split into lines, check
 *  `n*m` against `MAX_DIFF_CELLS` BEFORE allocating anything proportional to
 *  it, and only then hand off to the unguarded `diffLines`. A body over the
 *  bound reports its line counts so the caller can still say something
 *  concrete ("149 KB, 10,000 lines -- too large to diff") instead of a bare
 *  refusal. */
function diffBody(from: string, to: string): BodyDiffResult {
  const a = from.split("\n");
  const b = to.split("\n");
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return { tooLarge: true, fromLineCount: a.length, toLineCount: b.length };
  }
  return { tooLarge: false, lines: diffLines(a, b) };
}

/** Terms are a SET, identified by `term_id` -- a snapshot's own position or
 *  label can differ without the term itself having changed, and this diff
 *  only reports presence, matching what a reader actually wants to know:
 *  "which tags did this edit add or drop". */
function diffTerms(from: RevisionRow, to: RevisionRow): TermChange[] {
  const fromTerms = parseTerms(from);
  const toTerms = parseTerms(to);
  const fromIds = new Set(fromTerms.map((t) => t.term_id));
  const toIds = new Set(toTerms.map((t) => t.term_id));
  const changes: TermChange[] = [];
  for (const term of toTerms) if (!fromIds.has(term.term_id)) changes.push({ change: "added", term });
  for (const term of fromTerms) if (!toIds.has(term.term_id)) changes.push({ change: "removed", term });
  return changes;
}

/** `link_snapshot_json` has no per-entry id in this UI's types (evidence
 *  links are not populated by `publishRevision` today, per #33's analysis),
 *  so identity is the canonical JSON text of the whole entry -- the same
 *  move `session-link.ts`'s stored `evidence_ref` makes. Malformed or
 *  missing JSON reads as "no links", never as a crash: a revision predating
 *  this field, or one this client did not write, must still diff. */
function parseLinks(revision: RevisionRow): unknown[] {
  if (revision.link_snapshot_json === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(revision.link_snapshot_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function diffLinks(from: RevisionRow, to: RevisionRow): LinkChange[] {
  const fromLinks = parseLinks(from);
  const toLinks = parseLinks(to);
  const fromText = new Set(fromLinks.map((l) => JSON.stringify(l)));
  const toText = new Set(toLinks.map((l) => JSON.stringify(l)));
  const changes: LinkChange[] = [];
  for (const entry of toLinks) if (!fromText.has(JSON.stringify(entry))) changes.push({ change: "added", entry });
  for (const entry of fromLinks) if (!toText.has(JSON.stringify(entry))) changes.push({ change: "removed", entry });
  return changes;
}

/** `revision_no` is Int64 wire text (see `api/knowledge.ts` note 2) -- it can
 *  exceed `Number.MAX_SAFE_INTEGER` in principle, so a picker sorting
 *  revisions for the diff view compares via `BigInt`, not `Number(...)`,
 *  the same precision rule `RevisionHistory`'s neighbours already follow.
 *  Descending, newest first -- what a "pick two revisions to compare" list
 *  wants to show on top. */
export function compareRevisionNo(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  if (x === y) return 0;
  return x > y ? -1 : 1;
}

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

/** `from` and `to` are ANY two revisions of the same node -- caller decides
 *  which is base and which is compare; this function does not assume `to`
 *  is newer, so it works equally for "diff against the previous revision"
 *  and "diff a much older revision against head". */
export function revisionDiff(from: RevisionRow, to: RevisionRow): RevisionDiffResult {
  return {
    from: { id: from.id, revision_no: from.revision_no, title: from.title },
    to: { id: to.id, revision_no: to.revision_no, title: to.title },
    titleChanged: from.title !== to.title,
    bodyFormatChanged: from.body_format !== to.body_format,
    fieldChanges: diffFields(from, to),
    body: diffBody(from.body, to.body),
    termChanges: diffTerms(from, to),
    linkChanges: diffLinks(from, to),
  };
}
