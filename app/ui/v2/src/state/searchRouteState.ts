import type { SearchMode } from "./useKnowledgeSearch";

/** Restores `useKnowledgeSearch`'s initial `query`/`mode` from the Explore
 *  route (`#/explore?tab=search&q=...&mode=keyword|semantic`) -- fix-round
 *  finding #2 (PR #110 follow-up): ExploreView remounts when the URL swaps
 *  to `#/knowledge?node=...` and back (a different `view` in `useRoute`),
 *  which reset the hook's own `useState` and dropped the typed query. The
 *  route -- not the hook -- is the durable copy, the same contract
 *  `selectedPeer`/`selectedNode` already have with `App.tsx`.
 *
 * An unrecognised or missing `mode` param falls back to "keyword" rather
 * than propagating a bad string into render -- a hand-edited or stale link
 * should degrade to the default mode, not crash the search box.
 */
export function searchRouteState(route: { q: string | null; mode: string | null }): {
  query: string;
  mode: SearchMode;
} {
  return {
    query: route.q ?? "",
    mode: route.mode === "semantic" ? "semantic" : "keyword",
  };
}
