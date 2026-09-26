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
 *     (the stable identity a term snapshot carries): a set difference, not
 *     a line diff, plus `relabelled` for a kept term whose name/label
 *     snapshot changed.
 *   - `link_snapshot_json` -- likewise a set, keyed by the whole canonical
 *     JSON text of one entry (the evidence codec already canonicalizes it,
 *     so byte-equal text IS the identity check here -- see
 *     `session-link.ts`'s `evidenceRefText` for the same move on the
 *     server side).
 */
import type { RevisionRow, TermSnapshot } from "../api/knowledge";
import { parseTerms } from "../api/knowledge";

export type LineDiffOp = { op: "equal" | "added" | "removed"; text: string };

/** `relabelled` is the SAME `term_id` whose name or label snapshot differs
 *  between the two revisions: `from` is the older snapshot, `term` the newer. */
export type TermChange =
  | { change: "added" | "removed"; term: TermSnapshot }
  | { change: "relabelled"; from: TermSnapshot; term: TermSnapshot };

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

/** An empty body has NO lines. `"".split("\n")` is `[""]`, which made
 *  empty -> text diff as one removed empty line (fix-round 2 finding). */
function splitLines(body: string): string[] {
  return body === "" ? [] : body.split("\n");
}

/** The size-guarded entry point for the body diff. Lines shared at the START
 *  and END of both bodies are equal by construction, so they are emitted
 *  directly and only the differing middle goes into the LCS table -- an
 *  unchanged body, or a long body with one edited line, never builds a table
 *  at all (fix-round 2 finding: the guard used to run first, so an unchanged
 *  2,001-line body read "too large to diff" instead of "unchanged"). The
 *  middle's `n*m` is checked against `MAX_DIFF_CELLS` BEFORE allocating
 *  anything proportional to it; a body over the bound reports its WHOLE line
 *  counts so the caller can still say something concrete instead of a bare
 *  refusal. */
function diffBody(from: string, to: string): BodyDiffResult {
  const a = splitLines(from);
  const b = splitLines(to);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    return { tooLarge: true, fromLineCount: a.length, toLineCount: b.length };
  }
  const equal = (text: string): LineDiffOp => ({ op: "equal", text });
  return {
    tooLarge: false,
    lines: [...a.slice(0, head).map(equal), ...diffLines(midA, midB), ...a.slice(a.length - tail).map(equal)],
  };
}

/** The snapshot text a reader sees for a term. Position is deliberately NOT
 *  part of it: reordering tags is not a change to any tag. */
function termLabelText(t: TermSnapshot): string {
  return JSON.stringify([t.vocabulary_name_snapshot, t.term_name_snapshot, t.label_snapshot]);
}

/** Terms are a SET, identified by `term_id`: "which tags did this edit add or
 *  drop". A term present on both sides whose name or label SNAPSHOT differs
 *  is reported as `relabelled` -- fix-round 2 finding: matching by id alone
 *  hid a rename (`storage` -> `storage_renamed`) entirely, and #33 asks the
 *  UI to render taxonomy label snapshots, i.e. exactly what each revision
 *  recorded at the time. */
function diffTerms(from: RevisionRow, to: RevisionRow): TermChange[] {
  const fromTerms = parseTerms(from);
  const toTerms = parseTerms(to);
  const fromById = new Map(fromTerms.map((t) => [t.term_id, t]));
  const toIds = new Set(toTerms.map((t) => t.term_id));
  const changes: TermChange[] = [];
  for (const term of toTerms) {
    const before = fromById.get(term.term_id);
    if (before === undefined) changes.push({ change: "added", term });
    else if (termLabelText(before) !== termLabelText(term)) changes.push({ change: "relabelled", from: before, term });
  }
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
