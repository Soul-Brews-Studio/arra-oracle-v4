import type { SearchMode } from "../state/useKnowledgeSearch";

/** The query input + keyword/semantic toggle (#33 search box, R7: the two
 *  methods are never fused, so this is one query with a MODE, not two boxes).
 *  Presentational only -- `useKnowledgeSearch` owns the debounce and the
 *  fetch. */
export function KnowledgeSearchBox({
  query,
  onQuery,
  mode,
  onMode,
}: {
  query: string;
  onQuery: (q: string) => void;
  mode: SearchMode;
  onMode: (m: SearchMode) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="search knowledge (e.g. ลืม)"
        className="flex-1 rounded border border-edge bg-ink px-2 py-1 text-sm text-slate-100 outline-none focus:border-accent"
      />
      <div className="flex rounded border border-edge text-xs">
        {(["keyword", "semantic"] as const).map((m) => (
          <button
            key={m}
            onClick={() => onMode(m)}
            className={`px-2.5 py-1 capitalize ${
              mode === m ? "bg-accent/15 text-accent" : "text-muted hover:text-slate-200"
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}
