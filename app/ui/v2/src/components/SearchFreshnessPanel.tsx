import type { FreshnessState, FreshnessView } from "../state/searchFreshnessView";

/** Colour per node state. `unknown` and `loading` share the muted tone: an
 *  unread state must never look like the green "indexed". */
const TONE: Record<FreshnessState, string> = {
  indexed: "border-accent text-accent",
  pending: "border-[#e0c060] text-[#e0c060]",
  failed: "border-[#f07070] text-[#f07070]",
  unindexed: "border-[#f0a35e] text-[#f0a35e]",
  unknown: "border-muted text-muted",
  loading: "border-muted text-muted",
};

/** #33 design revision 2 "render freshness": the head revision's search state
 *  (`searchFreshnessView`), then the workspace-wide `getSearchFreshness`
 *  figures under their own heading. Indexing and embedding run outside this
 *  view (`indexRevisionChunks`, `embedPendingChunks`), so "re-check" re-reads
 *  rather than waiting for a push the server never sends. */
export function SearchFreshnessPanel({ view, onRecheck }: { view: FreshnessView; onRecheck: () => void }) {
  return (
    <section
      aria-label="search freshness"
      data-freshness-state={view.state}
      className="flex flex-none flex-col gap-2 border-t border-edge px-4 py-3 text-[11px]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold text-slate-200">Search freshness</h3>
        <span data-freshness="label" className={`rounded border px-1.5 py-0.5 font-medium ${TONE[view.state]}`}>
          {view.label}
        </span>
        {view.profile !== null && (
          <span className="font-mono text-muted [overflow-wrap:anywhere]" title="active embedding profile">
            {view.profile}
          </span>
        )}
        <button
          type="button"
          onClick={onRecheck}
          disabled={view.state === "loading"}
          className="ml-auto rounded border border-edge px-2 py-0.5 text-muted hover:text-slate-100 disabled:opacity-50"
        >
          re-check
        </button>
      </div>
      <p data-freshness="meaning" className="text-slate-300 [overflow-wrap:anywhere]">
        {view.meaning}
      </p>
      {view.chunks !== null && view.chunks.total > 0 && (
        <p className="text-muted">
          this revision: {view.chunks.ready} ready · {view.chunks.pending} pending · {view.chunks.failed} failed
          {view.errorCodes.length > 0 && (
            <span className="font-mono text-[#f07070] [overflow-wrap:anywhere]"> ({view.errorCodes.join(", ")})</span>
          )}
        </p>
      )}
      {view.workspace !== null && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted">
          {view.workspace.map((row) => (
            <div key={row.key} className="contents">
              <dt>{row.label}</dt>
              <dd data-freshness-ws={row.key} className="text-slate-300 [overflow-wrap:anywhere]">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
