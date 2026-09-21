import type { RevisionRow } from "../api/knowledge";
import type { ErrorEnvelope } from "../api/memory";
import { ErrorNote } from "./ErrorNote";
import { EmptyState } from "./EmptyState";

/** `listAcceptedHistory`'s rows, newest first, with the chain made visible:
 *  each row shows the `base_revision_id` it descends from, not just its own
 *  number, so a reader can see this is a chain of edits and not a flat list.
 *  `revisions` is NOT re-sorted here -- the caller decides order; this
 *  component only renders whatever order it is given. */
export function RevisionHistory({
  revisions,
  headRevisionId,
  loading,
  error,
  onSelect,
}: {
  revisions: RevisionRow[];
  headRevisionId: string | null;
  loading: boolean;
  error: ErrorEnvelope | null;
  onSelect: (revisionId: string) => void;
}) {
  if (loading) return <EmptyState title="loading history…" detail="" />;
  if (error) return <ErrorNote error={error} />;
  if (revisions.length === 0) {
    return <EmptyState title="no revisions" detail="this node has no accepted history yet" />;
  }

  return (
    <div className="flex flex-col gap-1 overflow-y-auto p-2">
      {revisions.map((rev) => {
        const isHead = rev.id === headRevisionId;
        return (
          <button
            key={rev.id}
            onClick={() => onSelect(rev.id)}
            className={`flex flex-col gap-0.5 rounded border px-2 py-1.5 text-left text-xs ${
              isHead ? "border-accent/50 bg-accent/10" : "border-edge hover:bg-panel"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-slate-200">#{rev.revision_no}</span>
              {isHead && <span className="text-[10px] uppercase tracking-wide text-accent">head</span>}
            </div>
            <span className="truncate text-slate-100">{rev.title}</span>
            {rev.change_reason && <span className="truncate text-muted">{rev.change_reason}</span>}
            <div className="flex items-center gap-1.5 text-[10px] text-muted">
              <span>{rev.created_at}</span>
              {/* base_revision_id is what makes this a CHAIN rather than a
                  list -- null only for the first revision of a node. */}
              <span>
                ⤷ base:{" "}
                {rev.base_revision_id ? (
                  <span className="font-mono">{rev.base_revision_id.slice(0, 8)}…</span>
                ) : (
                  "none (first revision)"
                )}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
