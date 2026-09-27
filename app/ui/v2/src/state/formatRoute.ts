import type { Route } from "./useRoute";

/** Builds the `#/view?query` hash for a `Route` -- the WRITE half of the
 *  `useRoute` <-> URL mapping (see `useRoute.ts`'s header for why it is the
 *  hash). Pure and DOM-free, same reason as `parseRoute` and the same
 *  round-3 style split (`useRoute.ts` used to export this directly,
 *  bringing it to three exports for one file).
 */
export function formatRoute(route: Route): string {
  const params = new URLSearchParams();
  // Only the keys that mean something in this view. Carrying a stale `node`
  // into the messages view would put a value in the URL that nothing reads,
  // which is how a link starts lying about what it restores.
  if (route.view === "messages" || route.view === "forum") {
    // The forum is the SAME session's messages rendered as reply trees, so it
    // carries the same peer/session selection -- switching tabs should not
    // lose where you are.
    if (route.peer !== null) params.set("peer", route.peer);
    if (route.session !== null) params.set("session", route.session);
  } else if (route.view === "explore") {
    // Explore carries all three selections plus the open tab: it is the one
    // view where peer, session and node are meaningful at the same time, so a
    // link to it has to restore the whole position, not one axis of it.
    if (route.peer !== null) params.set("peer", route.peer);
    if (route.session !== null) params.set("session", route.session);
    if (route.node !== null) params.set("node", route.node);
    if (route.tab !== null) params.set("tab", route.tab);
    // The search tab's own state (fix-round finding, PR #110 follow-up #2):
    // carried the same way as the rest of this view's selection, so Back
    // from the node view restores the typed query, not an empty box.
    if (route.q !== null) params.set("q", route.q);
    if (route.mode !== null) params.set("mode", route.mode);
  } else if (route.view === "knowledge") {
    if (route.node !== null) params.set("node", route.node);
  }
  // The overview falls through with no params on purpose: it is scoped to the
  // bank and workspace, never to a selection, so any key carried here would be
  // one the view does not read -- the way a link starts lying about what it
  // restores.
  const query = params.toString();
  return `#/${route.view}${query === "" ? "" : `?${query}`}`;
}
