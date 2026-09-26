import type { DependentOccurrence } from "../api/evidenceReview";
import type { CitingNodeStatus } from "../state/evidenceStatus.types";
import { reverseEvidenceLabels } from "../state/reverseEvidenceLabels";
import { EmptyState } from "./EmptyState";
import { EvidenceBadges } from "./EvidenceBadges";

/** One occurrence: some OTHER node's revision links to the revision this
 *  panel is showing dependents for. `is_snapshot_head` tells whether that
 *  citing revision is itself still the citing node's current head, or a
 *  historical one -- `revision_mode: "current"` (see `api/evidenceReview.ts`)
 *  means every occurrence here has it `true`, kept in the row anyway because
 *  it is part of the contract's exact occurrence shape. Its status badges
 *  (`reverseEvidenceLabels`, fix-round 2, #33 AC3) show the citing link's
 *  `capture_status` and whether the citing node is still recall-eligible. */
function OccurrenceRow({
  occurrence,
  citingStatus,
}: {
  occurrence: DependentOccurrence;
  citingStatus: ReadonlyMap<string, CitingNodeStatus>;
}) {
  return (
    <li className="flex flex-col gap-0.5 rounded border border-edge px-2 py-1.5 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-slate-200" title={occurrence.node_id}>
          {occurrence.node_id.slice(0, 10)}…
        </span>
        <span className="ml-auto text-muted">rev {occurrence.revision_no}</span>
      </div>
      <div className="flex items-center gap-2 text-muted">
        <span className="rounded border border-edge px-1 font-mono text-[10px]">{occurrence.link.target_kind}</span>
        <span>{occurrence.link.relation}</span>
      </div>
      <EvidenceBadges labels={reverseEvidenceLabels(occurrence, citingStatus)} />
    </li>
  );
}

/** Reverse evidence: who cites THIS revision (#33 R12, `scanDependents`).
 *  `hasMore`/`onLoadMore` mirror `TracePanel`'s hits pagination -- a
 *  dependents scan is bounded per page by the kernel's own budgets
 *  (`association-evidence-v1.md` §4), so "load more" is a real, expected
 *  interaction here, not an edge case. */
export function DependentsPanel({
  rows,
  loading,
  error,
  hasMore,
  onLoadMore,
  citingStatus,
}: {
  rows: DependentOccurrence[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  citingStatus: ReadonlyMap<string, CitingNodeStatus>;
}) {
  return (
    <section className="flex flex-col gap-2 border-b border-edge p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Reverse evidence</h3>

      {error !== null && <p className="text-[11px] text-rose-300">{error}</p>}

      {loading && rows.length === 0 ? (
        <EmptyState title="loading…" detail="" />
      ) : rows.length === 0 ? (
        <EmptyState title="nothing cites this revision" detail="no other node's current head links here" />
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((o, i) => (
            <OccurrenceRow
              key={`${o.node_id}:${o.revision_no}:${o.link.position}:${i}`}
              occurrence={o}
              citingStatus={citingStatus}
            />
          ))}
        </ul>
      )}

      {hasMore && (
        <button
          onClick={onLoadMore}
          className="self-start rounded border border-edge px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-accent"
        >
          load more dependents
        </button>
      )}
    </section>
  );
}
