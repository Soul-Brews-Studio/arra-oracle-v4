import type { RevisionRow } from "../api/knowledge";
import { RevisionDiff } from "./RevisionDiff";

/** The Knowledge view's "diff <from> vs <to>" row plus the diff itself.
 *  `revisions` arrive newest first; the parent owns which two are picked
 *  (and re-validates them when history changes), this only renders.
 *  #33 AC2 round 4: each option is `#N — <title>`, and a <select> is as wide
 *  as its longest option -- a 210-char title with a code path made both
 *  1219px, sideways scrolling at 375 AND at 1440. `min-w-0 max-w-full` caps
 *  each at the row (the row wraps), and the option text truncates. */
export function RevisionDiffPicker({
  revisions,
  from,
  to,
  onFrom,
  onTo,
}: {
  revisions: RevisionRow[];
  from: RevisionRow | null;
  to: RevisionRow | null;
  onFrom: (id: string) => void;
  onTo: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-edge p-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span className="uppercase tracking-wide">diff</span>
        <select
          value={from?.id ?? ""}
          onChange={(e) => onFrom(e.target.value)}
          aria-label="Diff from revision"
          className="min-w-0 max-w-full rounded border border-edge bg-ink px-2 py-1 text-slate-100 outline-none focus:border-accent"
        >
          {revisions.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.revision_no} — {r.title}
            </option>
          ))}
        </select>
        <span>vs</span>
        <select
          value={to?.id ?? ""}
          onChange={(e) => onTo(e.target.value)}
          aria-label="Diff to revision"
          className="min-w-0 max-w-full rounded border border-edge bg-ink px-2 py-1 text-slate-100 outline-none focus:border-accent"
        >
          {revisions.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.revision_no} — {r.title}
            </option>
          ))}
        </select>
      </div>
      {from !== null && to !== null && from.id !== to.id ? (
        <RevisionDiff from={from} to={to} />
      ) : (
        <p className="text-[11px] text-muted">pick two different revisions to diff</p>
      )}
    </div>
  );
}
