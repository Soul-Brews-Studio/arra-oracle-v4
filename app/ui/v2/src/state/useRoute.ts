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
  view: "messages" | "knowledge";
  peer: string | null;
  session: string | null;
  node: string | null;
};

const EMPTY: Route = { view: "messages", peer: null, session: null, node: null };

function parse(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const view = path.replace(/^\/+/, "") === "knowledge" ? "knowledge" : "messages";
  return {
    view,
    peer: params.get("peer"),
    session: params.get("session"),
    node: params.get("node"),
  };
}

function format(route: Route): string {
  const params = new URLSearchParams();
  // Only the keys that mean something in this view. Carrying a stale `node`
  // into the messages view would put a value in the URL that nothing reads,
  // which is how a link starts lying about what it restores.
  if (route.view === "messages") {
    if (route.peer !== null) params.set("peer", route.peer);
    if (route.session !== null) params.set("session", route.session);
  } else {
    if (route.node !== null) params.set("node", route.node);
  }
  const query = params.toString();
  return `#/${route.view}${query === "" ? "" : `?${query}`}`;
}

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

  return {
    route,
    push: useCallback((patch: Partial<Route>) => go(patch, "push"), [go]),
    replace: useCallback((patch: Partial<Route>) => go(patch, "replace"), [go]),
  };
}
