import { useCallback, useEffect, useState } from "react";

/** Where you are, kept in the URL hash so a reload and the back button both
 *  work.
 *
 * `#/messages?peer=alice&session=sess-a`
 * `#/knowledge?node=gO0ER2i24z0XVa4OiFthi`
 *
 * The HASH, not the path, and not a query on the path. Two reasons, and the
 * first is the one that would bite:
 *
 *   - This app is served as static files by the API server, which has no
 *     SPA rewrite. `/v2/knowledge` would be a real 404 on reload, so a
 *     path-based route would work until the first refresh and then break in
 *     the one situation this exists to fix.
 *   - The hash never reaches the server, so a selection can never be mistaken
 *     for a route the API is supposed to answer.
 *
 * Selections go through `push`, which writes a real history entry, so Back
 * steps through what you actually clicked. `replace` exists for corrections
 * that should not become a step -- a redirect off an invalid state should not
 * be somewhere Back can return you to.
 *
 * Deliberately NOT in the URL: the bearer token. `useToken` accepts one from
 * the query once and then strips it, precisely so it never becomes part of a
 * shareable location like this one.
 */
export type Route = {
  view: "overview" | "messages" | "forum" | "knowledge" | "explore";
  /** Which detail tab the explore view has open. */
  tab: string | null;
  peer: string | null;
  session: string | null;
  node: string | null;
  /** The Explore search tab's typed query and mode (fix-round finding, PR
   *  #110 follow-up #2). Kept as bare strings here, the same idiom `tab`
   *  already uses -- this router does not know about `SearchMode`; whoever
   *  reads these casts, same as `route.tab as ExploreTab`. */
  q: string | null;
  mode: string | null;
};

/** Every slug this router answers to, in tab order. A list rather than a chain
 *  of ternaries because `parse` and the tab bar have to agree on the set, and
 *  a view added to one and forgotten in the other is a dead tab. */
const VIEWS = ["overview", "explore", "messages", "forum", "knowledge"] as const;

const isView = (slug: string): slug is Route["view"] => (VIEWS as readonly string[]).includes(slug);

/** Whether the hash names something this router answers to. `parse` falls back
 *  silently, which is right for RENDERING and wrong for the address bar; this
 *  is what lets the hook tell "I corrected something" from "nothing to
 *  correct". An EMPTY hash counts as known: it already restores the overview,
 *  so it is a valid short form rather than a stale link. */
function isKnownHash(hash: string): boolean {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const slug = (raw.split("?")[0] ?? "").replace(/^\/+/, "");
  return slug === "" || isView(slug);
}

/** An empty hash lands on the overview: it is the only view that needs no
 *  selection to say something true, so it is what a first visit should open.
 *  An unrecognised slug lands there too -- a stale link should arrive
 *  somewhere that explains the server rather than on a screen asking for a
 *  peer the link never named. */
const EMPTY: Route = { view: "overview", peer: null, session: null, node: null, tab: null, q: null, mode: null };

export function parse(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const slug = path.replace(/^\/+/, "");
  const view: Route["view"] = isView(slug) ? slug : EMPTY.view;
  return {
    view,
    peer: params.get("peer"),
    session: params.get("session"),
    node: params.get("node"),
    tab: params.get("tab"),
    q: params.get("q"),
    mode: params.get("mode"),
  };
}

function format(route: Route): string {
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

export { format };

export function useRoute(): {
  route: Route;
  push: (patch: Partial<Route>) => void;
  replace: (patch: Partial<Route>) => void;
} {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined" ? EMPTY : parse(window.location.hash),
  );

  // The back/forward buttons change the hash without going through `push`,
  // so the URL is the source of truth and this listener is how state follows
  // it -- not the other way around.
  // BOTH events, on purpose. `pushState` with a hash-only change does not
  // reliably fire `hashchange`, and a Back that undoes a `pushState` fires
  // `popstate`. Listening to only one of them leaves a class of navigation
  // where the URL moves and the screen does not -- the exact bug this hook
  // exists to prevent. Re-parsing is idempotent, so a double fire is free.
  useEffect(() => {
    const sync = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const go = useCallback(
    (patch: Partial<Route>, mode: "push" | "replace") => {
      setRoute((current) => {
        const next = { ...current, ...patch };
        const href = format(next);
        if (href !== window.location.hash) {
          if (mode === "push") window.history.pushState(null, "", href);
          else window.history.replaceState(null, "", href);
        }
        return next;
      });
    },
    [],
  );

  const push = useCallback((patch: Partial<Route>) => go(patch, "push"), [go]);
  const replace = useCallback((patch: Partial<Route>) => go(patch, "replace"), [go]);

  // The fallback in `parse` fixes the SCREEN; this fixes the URL. A hash that
  // named no view used to stay in the address bar after being silently
  // redirected, so Back returned to the dead link and copying the location
  // kept spreading it. `replace`, because a correction should not become a
  // history step -- the reason this hook has a `replace` at all.
  useEffect(() => {
    if (typeof window !== "undefined" && !isKnownHash(window.location.hash)) replace({});
  }, [route, replace]);

  return { route, push, replace };
}
