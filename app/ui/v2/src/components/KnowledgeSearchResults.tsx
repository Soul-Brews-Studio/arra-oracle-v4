import type { SearchMode } from "../state/useKnowledgeSearch";
import { searchHitView, type KeywordHitWire, type SemanticHitWire } from "../state/searchHitView";
import { searchState } from "../state/searchState";

/** Renders whatever `searchState` decides -- empty query, loading, no
 *  results (with the index_unavailable/short_query note if the scan
 *  fallback ran), model_unavailable, a bare error, or the hit list itself.
 *  All the branching logic is pure and tested in `state/searchState.ts` /
 *  `state/searchHitView.ts`; this component only lays the result out. */
export function KnowledgeSearchResults({
  query,
  mode,
  loading,
  errorCode,
  hits,
  scanReason,
  embeddingProfile,
  onOpenNode,
}: {
  query: string;
  mode: SearchMode;
  loading: boolean;
  errorCode: string | null;
  hits: (KeywordHitWire | SemanticHitWire)[];
  scanReason: "short_query" | "index_unavailable" | null;
  embeddingProfile: string | null;
  onOpenNode: (nodeId: string) => void;
}) {
  const state = searchState({ query, loading, errorCode, hitCount: hits.length, scanReason });

  if (state.kind === "empty_query") {
    return <p className="px-3 py-4 text-xs text-muted">Type a query to search this workspace's knowledge.</p>;
  }
  if (state.kind === "loading") {
    return <p className="px-3 py-4 text-xs text-muted">Searching…</p>;
  }
  if (state.kind === "model_unavailable") {
    return (
      <div className="mx-3 my-3 rounded border border-[#f0a35e]/40 bg-[#f0a35e]/10 px-3 py-2 text-xs">
        <p className="font-semibold text-[#f0a35e]">Model unavailable</p>
        <p className="mt-1 text-muted">{state.detail}</p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mx-3 my-3 rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs">
        <span className="font-semibold text-rose-300">{state.title}</span>
        <p className="mt-1 text-muted">{state.detail}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      {state.scanNote !== null && (
        <p className="border-b border-edge px-3 py-1.5 text-[11px] text-[#f0a35e]">{state.scanNote}</p>
      )}
      {mode === "semantic" && embeddingProfile !== null && (
        <p className="border-b border-edge px-3 py-1.5 text-[11px] text-muted">embedding_profile: {embeddingProfile}</p>
      )}
      {state.kind === "no_results" ? (
        <p className="px-3 py-4 text-xs text-muted">No results for "{query}".</p>
      ) : (
        <ul>
          {hits.map((hit) => {
            const view = searchHitView(hit, mode);
            return (
              <li key={view.key} className="border-b border-edge px-3 py-2">
                <button onClick={() => onOpenNode(view.node_id)} className="block w-full text-left hover:text-accent">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 font-mono text-muted">{view.rankLabel}</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-100">{view.title}</span>
                    {view.matchLabel !== null && (
                      <span className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted">
                        {view.matchLabel}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-[11px] text-muted">{view.snippet}</p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
