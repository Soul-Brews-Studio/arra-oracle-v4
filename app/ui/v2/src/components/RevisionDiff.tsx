import { type ReactNode, useMemo } from "react";
import type { RevisionRow, TermSnapshot } from "../api/knowledge";
import { pairDiffLines } from "../state/pairDiffLines";
import { type FieldChange, revisionDiff } from "../state/revisionDiff";

const ROW_CLASS: Record<"equal" | "changed" | "added" | "removed", string> = {
  equal: "",
  changed: "bg-[#f0a35e]/10",
  added: "bg-accent/10",
  removed: "bg-rose-500/10",
};

const FIELD_LABEL: Record<FieldChange["field"], string> = {
  author_peer_name: "author",
  observer_peer_name: "observer",
  subject_peer_name: "subject",
  session_name: "session",
  is_active: "is_active",
  valid_from: "valid_from",
  valid_to: "valid_to",
  change_reason: "change_reason",
  fields: "fields",
};

/** `vocabulary:term`, plus the label snapshot when the revision recorded one. */
function termText(t: TermSnapshot): string {
  const base = `${t.vocabulary_name_snapshot}:${t.term_name_snapshot}`;
  return t.label_snapshot === null ? base : `${base} (${t.label_snapshot})`;
}

/** `—` for `null`, otherwise the value verbatim -- the same "explicit null,
 *  not empty string" distinction `RevisionRow` itself carries. */
function cell(value: string | null): ReactNode {
  return value === null ? <span className="text-muted/40">—</span> : value;
}

/** Two accepted revisions of the same node, side by side, field level (#33).
 *  Presentational only: `from`/`to` are two ALREADY-FETCHED `RevisionRow`s
 *  (from `listAcceptedHistory`'s in-memory chain), and `revisionDiff` does
 *  the actual comparison -- see that file for why title/body, per-revision
 *  fields, terms and links are each diffed differently.
 *
 * "Side by side" is the body table: one row per aligned line, old on the
 * left, new on the right, a changed line on ONE row rather than a removed
 * row stacked over an unrelated added row. Term and link changes are sets,
 * so they render as two flat added/removed lists instead of a line grid --
 * a positional pairing would invent an order neither snapshot has. The
 * fields table renders ALL nine comparable fields (not just the changed
 * ones), because "nothing changed here" is itself the useful answer for a
 * revision that only edited the body -- the fix-round finding this
 * component addresses was exactly a revision whose real change (author,
 * session, valid_to, ...) was invisible next to an unchanged body.
 */
export function RevisionDiff({ from, to }: { from: RevisionRow; to: RevisionRow }) {
  const diff = useMemo(() => revisionDiff(from, to), [from, to]);
  const rows = useMemo(
    () => (diff.body.tooLarge ? [] : pairDiffLines(diff.body.lines)),
    [diff.body],
  );
  const bodyIdentical = !diff.body.tooLarge && from.body === to.body;

  return (
    <div className="flex flex-col gap-3 rounded border border-edge bg-panel p-3 text-xs">
      <div className="grid grid-cols-2 gap-3 border-b border-edge pb-2">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">from · rev {diff.from.revision_no}</p>
          <p
            title={diff.from.title}
            className={`break-words text-slate-100 ${diff.titleChanged ? "text-rose-300 line-through" : ""}`}
          >
            {diff.from.title}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">to · rev {diff.to.revision_no}</p>
          <p
            title={diff.to.title}
            className={`break-words text-slate-100 ${diff.titleChanged ? "text-accent" : ""}`}
          >
            {diff.to.title}
          </p>
        </div>
      </div>

      {diff.bodyFormatChanged && (
        <p className="text-[11px] text-[#f0a35e]">
          body_format changed: {from.body_format} → {to.body_format}
        </p>
      )}

      <div className="overflow-hidden rounded border border-edge">
        <table className="w-full table-fixed border-collapse font-mono text-[10px]">
          <tbody>
            {diff.fieldChanges.map((c) => (
              <tr key={c.field} className={c.changed ? ROW_CLASS.changed : ""}>
                <td className="w-1/5 border-r border-edge/60 px-2 py-0.5 align-top text-muted">
                  {FIELD_LABEL[c.field]}
                </td>
                <td className="w-2/5 whitespace-pre-wrap break-words border-r border-edge/60 px-2 py-0.5 align-top text-slate-200">
                  {cell(c.from)}
                </td>
                <td className="w-2/5 whitespace-pre-wrap break-words px-2 py-0.5 align-top text-slate-200">
                  {cell(c.to)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {bodyIdentical && <p className="text-[11px] text-muted">body unchanged (shown below)</p>}

      {diff.body.tooLarge ? (
        <div className="rounded border border-[#f0a35e]/40 bg-[#f0a35e]/10 p-3 text-[11px] text-[#f0a35e]">
          Body too large to diff ({diff.body.fromLineCount.toLocaleString()} vs{" "}
          {diff.body.toLineCount.toLocaleString()} lines) — field changes above are still complete.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-edge">
          <table className="w-full table-fixed border-collapse font-mono text-[11px]">
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className={ROW_CLASS[row.kind]}>
                  <td className="w-1/2 whitespace-pre-wrap break-words border-r border-edge/60 px-2 py-0.5 align-top text-slate-200">
                    {row.left === null ? <span className="text-muted/40">—</span> : row.left}
                  </td>
                  <td className="w-1/2 whitespace-pre-wrap break-words px-2 py-0.5 align-top text-slate-200">
                    {row.right === null ? <span className="text-muted/40">—</span> : row.right}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
            terms ({diff.termChanges.length})
          </p>
          {diff.termChanges.length === 0 ? (
            <p className="text-muted">no term changes</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {diff.termChanges.map((c, i) =>
                c.change === "relabelled" ? (
                  // Same term_id, different snapshot: each revision keeps the
                  // label it was published with, so both are shown.
                  <li key={i} className="break-words text-[#f0a35e]">
                    ~ {termText(c.from)} → {termText(c.term)}
                  </li>
                ) : (
                  <li key={i} className={c.change === "added" ? "text-accent" : "text-rose-300"}>
                    {c.change === "added" ? "+" : "−"} {termText(c.term)}
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
            links ({diff.linkChanges.length})
          </p>
          {diff.linkChanges.length === 0 ? (
            <p className="text-muted">no link changes</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {diff.linkChanges.map((c, i) => (
                <li key={i} className={c.change === "added" ? "text-accent" : "text-rose-300"}>
                  {c.change === "added" ? "+" : "−"} {JSON.stringify(c.entry)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
