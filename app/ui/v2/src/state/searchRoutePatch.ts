import type { SearchMode } from "./useKnowledgeSearch";

/** Builds the Explore route patch that keeps the search box's `q`/`mode` in
 *  the URL as the user types or toggles mode -- fix-round finding #2 (PR
 *  #110 follow-up). The caller applies this through `route.replace`, never
 *  `route.push`: a history entry per keystroke would make every character
 *  typed its own Back step, and the point here is the OPPOSITE -- the
 *  current explore entry (the one Back returns to from the node view) needs
 *  to always carry the latest query, not spawn new entries for it.
 *
 * An empty query clears the `q` param instead of leaving `q=` in the
 * address bar, matching how the rest of `useRoute`'s `format` omits params
 * that mean nothing right now (see `useRoute.ts`'s `format`).
 */
export function searchRoutePatch(query: string, mode: SearchMode): { q: string | null; mode: string | null } {
  return { q: query === "" ? null : query, mode };
}
