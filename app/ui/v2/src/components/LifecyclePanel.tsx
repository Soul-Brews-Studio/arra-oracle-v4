import { isSupersedeEvent, type LifecycleEventRow, type RecallEligibility } from "../api/evidenceReview";
import { EmptyState } from "./EmptyState";

/** One `supersede_log` row. `new_id`/`new_revision_id` both present is a
 *  supersede event; both absent is a retirement -- there is no separate
 *  event-kind column (`isSupersedeEvent`, mirrored from `lifecycle.ts`). */
function EventRow({ event }: { event: LifecycleEventRow }) {
  const supersede = isSupersedeEvent(event);
  return (
    <li className="flex flex-col gap-0.5 rounded border border-edge px-2 py-1.5 text-[11px]">
      <div className="flex items-center gap-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
            supersede ? "border-accent/40 bg-accent/10 text-accent" : "border-rose-400/40 bg-rose-400/10 text-rose-300"
          }`}
        >
          {supersede ? "superseded" : "retired"}
        </span>
        <span className="text-muted">{event.superseded_at}</span>
      </div>
      <p className="truncate text-slate-200">{event.old_title ?? event.old_id}</p>
      {supersede && (
        <p className="truncate text-muted">
          → {event.new_title ?? event.new_id}
        </p>
      )}
      <p className="text-muted">
        reason: {event.reason}
        {event.peer_name !== null && ` · by ${event.peer_name}`}
      </p>
    </li>
  );
}

/** Node lifecycle: recall eligibility plus the supersede/retire history
 *  (#29, #33 evidence review). `eligible: false` means SOME later event
 *  (`old_id = this node`) exists in `supersede_log` -- the same "witness"
 *  the kernel names in `witness_event_id`, shown here as a plain count
 *  rather than re-deriving meaning the row does not carry. */
export function LifecyclePanel({
  nodeId,
  recall,
  recallError,
  history,
  loading,
  error,
}: {
  nodeId: string | null;
  recall: RecallEligibility | null;
  recallError: string | null;
  history: LifecycleEventRow[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <section className="flex flex-col gap-2 p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Lifecycle</h3>

      {nodeId === null ? (
        <EmptyState title="no node selected" detail="pick a node in the Nodes tab" />
      ) : loading ? (
        <EmptyState title="loading…" detail={nodeId} />
      ) : (
        <>
          {recallError !== null ? (
            <p className="text-[11px] text-rose-300">{recallError}</p>
          ) : recall !== null ? (
            <span
              className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                recall.eligible ? "border-accent/40 text-accent" : "border-rose-400/40 text-rose-300"
              }`}
              title={`witness_event_id ${recall.witness_event_id}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${recall.eligible ? "bg-accent" : "bg-rose-400"}`} />
              {recall.eligible ? "eligible for recall" : "not eligible — superseded or retired"}
            </span>
          ) : null}

          {error !== null && <p className="text-[11px] text-rose-300">{error}</p>}
          {history.length === 0 ? (
            <EmptyState title="no lifecycle events" detail="never superseded or retired" />
          ) : (
            <ul className="flex flex-col gap-1">
              {history.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
