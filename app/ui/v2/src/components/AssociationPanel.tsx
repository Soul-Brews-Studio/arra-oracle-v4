import type { AssociationResult } from "../api/evidenceReview";
import { directEvidenceLabels } from "../state/directEvidenceLabels";
import type { CitedRevisionStatus } from "../state/evidenceStatus.types";
import { EmptyState } from "./EmptyState";
import { EvidenceBadges } from "./EvidenceBadges";

/** Direct evidence: what THIS revision cites (#33 R12, `getRevisionAssociations`).
 *  Always the node's captured head -- this review surface has no
 *  per-revision picker; the diff view (`RevisionDiff`) already covers
 *  comparing two exact revisions against each other. `terms`/`links` are the
 *  derived projection rows verbatim: `target` is shown as the stored
 *  canonical `{target_kind, target}` JSON text, the same restraint
 *  `TracePanel`'s `HitRow` takes rather than inventing a per-kind display.
 *
 * Fix-round 2 (#33 AC3): every link now carries its status badges
 * (`directEvidenceLabels`) -- its `capture_status`, and for a `node_revision`
 * target the live state of the cited revision from `citedStatus` -- so an
 * unresolved or stale citation no longer looks identical to a captured,
 * current one. */
export function AssociationPanel({
  row,
  loading,
  error,
  citedStatus,
}: {
  row: AssociationResult | null;
  loading: boolean;
  error: string | null;
  citedStatus: ReadonlyMap<string, CitedRevisionStatus>;
}) {
  return (
    <section className="flex flex-col gap-2 border-b border-edge p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Direct evidence</h3>

      {loading ? (
        <EmptyState title="loading…" detail="" />
      ) : error !== null ? (
        <p className="text-[11px] text-rose-300">{error}</p>
      ) : row === null ? (
        <EmptyState title="no accepted revision" detail="this node has no accepted head yet" />
      ) : (
        <div className="flex flex-col gap-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-muted" title={row.revision_id}>
              rev {row.revision_id.slice(0, 8)}…
            </span>
            {row.is_snapshot_head && (
              <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                head
              </span>
            )}
          </div>

          <div>
            <p className="font-medium uppercase tracking-wide text-muted">terms ({row.terms.length})</p>
            {row.terms.length === 0 ? (
              <p className="text-muted">no terms on this revision</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5">
                {row.terms.map((t) => (
                  <li key={t.term_id} className="truncate text-slate-200">
                    {t.vocabulary_name_snapshot}:{t.term_name_snapshot}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="font-medium uppercase tracking-wide text-muted">links ({row.links.length})</p>
            {row.links.length === 0 ? (
              <p className="text-muted">this revision cites nothing</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5">
                {row.links.map((l) => (
                  <li key={l.position} className="flex flex-col gap-0.5 rounded border border-edge px-2 py-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-edge px-1 font-mono text-[10px] text-muted">
                        {l.target_kind}
                      </span>
                      <span className="text-muted">{l.relation}</span>
                    </div>
                    <p className="truncate font-mono text-muted" title={l.target}>
                      {l.target}
                    </p>
                    <EvidenceBadges labels={directEvidenceLabels(l, citedStatus)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
