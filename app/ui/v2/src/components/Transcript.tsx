import type { MessageRow as MessageRowType } from "../api/memory";
import { EmptyState } from "./EmptyState";
import { MessageRow } from "./MessageRow";

/** Presentational only -- fetching, paging state, and the highlight set all
 *  come from the parent. Newest at the bottom, like a chat log, because this
 *  is a session transcript, not a reverse-chron feed. */
export function Transcript({
  messages,
  loading,
  error,
  selectedSession,
  highlighted,
  onLoadMore,
  hasMore,
}: {
  messages: MessageRowType[];
  loading: boolean;
  error: string | null;
  selectedSession: string | null;
  highlighted: Set<string>;
  onLoadMore: () => void;
  hasMore: boolean;
}) {
  if (!selectedSession) {
    return (
      <EmptyState
        title="No session selected"
        detail="Pick a session from the left rail to see its messages."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
      {hasMore && (
        <button
          onClick={onLoadMore}
          disabled={loading}
          className="mx-auto rounded border border-edge px-3 py-1 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {loading ? "loading…" : "load earlier messages"}
        </button>
      )}
      {/* `error` here is a plain message string set by the fetch-owning
          parent; the structured ErrorEnvelope rendering lives in
          ErrorNote, used wherever a raw ApiResult body is available. */}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {messages.length === 0 && !loading && !error && (
        <EmptyState title="No messages yet" detail="This session has no messages -- append one below." />
      )}
      {messages.map((m) => (
        <MessageRow key={m.public_id} message={m} highlighted={highlighted.has(m.public_id)} />
      ))}
      {loading && messages.length === 0 && <p className="text-center text-xs text-muted">loading…</p>}
    </div>
  );
}
