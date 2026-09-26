import type { SessionLinkRow } from "../api/evidenceReview";
import { EmptyState } from "./EmptyState";

/** Session links for the SELECTED session (#28, #33 evidence review).
 *  `direction` flips which physical column is matched -- "from" finds links
 *  this session starts, "to" finds links pointing at it -- because a link
 *  is directed (`continues`/`forked_from`/`related_to`) and a session can be
 *  evidence for another session's link just as easily as the reverse. */
export function SessionLinksPanel({
  sessionName,
  direction,
  onDirectionChange,
  rows,
  loading,
  error,
}: {
  sessionName: string | null;
  direction: "from" | "to";
  onDirectionChange: (d: "from" | "to") => void;
  rows: SessionLinkRow[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <section className="flex flex-col gap-2 border-b border-edge p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Session links</h3>
        <div className="ml-auto flex gap-1 text-[11px]">
          {(["from", "to"] as const).map((d) => (
            <button
              key={d}
              onClick={() => onDirectionChange(d)}
              className={`rounded border px-2 py-0.5 ${
                direction === d ? "border-accent/50 bg-accent/10 text-accent" : "border-edge text-muted"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {sessionName === null ? (
        <EmptyState title="no session selected" detail="pick a session on the left to see its links" />
      ) : loading ? (
        <EmptyState title="loading…" detail={sessionName} />
      ) : error !== null ? (
        <p className="text-[11px] text-rose-300">{error}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="no links"
          detail={`no session ${direction === "from" ? "starts at" : "points at"} ${sessionName}`}
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((link) => (
            <li key={link.id} className="flex flex-col gap-0.5 rounded border border-edge px-2 py-1.5 text-[11px]">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-slate-200">{link.from_session_name}</span>
                <span className="text-muted">--{link.relation}--&gt;</span>
                <span className="truncate font-mono text-slate-200">{link.to_session_name}</span>
              </div>
              <div className="flex items-center gap-2 text-muted">
                <span>{link.created_by_peer_name ?? "unattributed"}</span>
                <span>{link.created_at}</span>
              </div>
              {link.evidence_ref !== null && (
                <p className="truncate font-mono text-muted" title={link.evidence_ref}>
                  evidence: {link.evidence_ref}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
