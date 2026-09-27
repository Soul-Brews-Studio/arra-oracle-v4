import type { TraceHitRow, TraceRow } from "../api/evidenceReview";
import { EmptyState } from "./EmptyState";

const STATUS_CLASS: Record<TraceRow["status"], string> = {
  open: "border-accent/40 bg-accent/10 text-accent",
  complete: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  abandoned: "border-muted/40 bg-muted/10 text-muted",
};

/** One trace hit, its target shown as the stored canonical `{target_kind,
 *  target}` JSON text -- re-parsing it into a per-kind rendering would
 *  invent a display shape `TARGET_KEYS` (contracts/evidence-v1.ts) does not
 *  define for a read path, the same restraint `evidenceRefText` takes on
 *  the server. `ref` is the human-facing locator (a citation label, a byte
 *  offset spelling); `target` is what it points at. */
function HitRow({ hit }: { hit: TraceHitRow }) {
  return (
    <li className="flex flex-col gap-0.5 rounded border border-edge px-2 py-1.5 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="rounded border border-edge px-1 py-0 font-mono text-[10px] text-muted">{hit.kind}</span>
        <span className="truncate text-slate-100">{hit.ref}</span>
        <span className="ml-auto font-mono text-[10px] text-muted">#{hit.position}</span>
      </div>
      <p className="truncate font-mono text-muted">{hit.target}</p>
      {(hit.line_start !== null || hit.line_end !== null) && (
        <p className="text-muted">
          lines {hit.line_start ?? "?"}–{hit.line_end ?? "?"}
        </p>
      )}
      {hit.excerpt !== null && <p className="whitespace-pre-wrap text-slate-200">{hit.excerpt}</p>}
    </li>
  );
}

/** A trace, looked up by id, and its hits (#33 evidence review). There is no
 *  `listTraces` -- a trace is found by an id the caller already holds, the
 *  same "no enumeration" property nodes have (`api/knowledge.ts`). This
 *  component is purely presentational; `useEvidenceReview` owns the fetch. */
export function TracePanel({
  traceId,
  onTraceIdChange,
  onLookup,
  loading,
  trace,
  error,
  hits,
  hitsError,
  hasMoreHits,
  onLoadMoreHits,
}: {
  traceId: string;
  onTraceIdChange: (id: string) => void;
  onLookup: () => void;
  loading: boolean;
  trace: TraceRow | null;
  error: string | null;
  hits: TraceHitRow[];
  hitsError: string | null;
  hasMoreHits: boolean;
  onLoadMoreHits: () => void;
}) {
  return (
    <section className="flex flex-col gap-2 border-b border-edge p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Trace</h3>
      <div className="flex items-center gap-2">
        <input
          value={traceId}
          onChange={(e) => onTraceIdChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onLookup();
          }}
          placeholder="trace id (nanoid21)"
          aria-label="Trace id"
          className="min-w-0 flex-1 rounded border border-edge bg-ink px-2 py-1 font-mono text-xs text-slate-100 outline-none focus:border-accent"
        />
        <button
          onClick={onLookup}
          disabled={loading || traceId.trim() === ""}
          className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "Looking up…" : "Look up"}
        </button>
      </div>

      {error !== null && <p className="text-[11px] text-rose-300">{error}</p>}

      {trace === null ? (
        error === null && <EmptyState title="no trace looked up" detail="paste a trace id above" />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs">
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[trace.status]}`}>
              {trace.status}
            </span>
            <span className="truncate text-slate-100">{trace.name}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted">
            <dt>session</dt>
            <dd className="truncate text-slate-200">{trace.session_name ?? "—"}</dd>
            <dt>peer</dt>
            <dd className="truncate text-slate-200">{trace.peer_name ?? "—"}</dd>
            <dt>query</dt>
            <dd className="truncate text-slate-200">{trace.query}</dd>
            <dt>depth</dt>
            <dd className="text-slate-200">{trace.depth}</dd>
          </dl>

          {hitsError !== null && <p className="text-[11px] text-rose-300">{hitsError}</p>}
          {hits.length === 0 ? (
            <EmptyState title="no hits" detail="this trace has zero hits" />
          ) : (
            <ul className="flex flex-col gap-1">
              {hits.map((hit) => (
                <HitRow key={hit.position} hit={hit} />
              ))}
            </ul>
          )}
          {hasMoreHits && (
            <button
              onClick={onLoadMoreHits}
              className="self-start rounded border border-edge px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-accent"
            >
              load more hits
            </button>
          )}
        </div>
      )}
    </section>
  );
}
