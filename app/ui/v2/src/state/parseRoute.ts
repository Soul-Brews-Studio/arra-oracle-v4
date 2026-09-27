import type { Route } from "./useRoute";
import { isRouteView } from "./routeViews";

/** Reads a `#/view?query` hash into a `Route` -- the READ half of the
 *  `useRoute` <-> URL mapping (see that file's header comment for why it is
 *  the hash, not the path). Pure and DOM-free on purpose (no `window`
 *  inside): `useRoute` is the only caller that touches `window.location`,
 *  so this half is testable with a plain string (`parseRoute.test.ts`).
 *
 * Split out of `useRoute.ts` (round-3 style finding): that file used to
 * export `parse`, `format` and `useRoute` -- three exports for one file,
 * the same violation the rest of this codebase's "one exported function per
 * file" idiom exists to prevent elsewhere (`searchRoutePatch.ts`,
 * `searchRouteState.ts`, etc).
 *
 * An unrecognised slug falls back to "overview" -- the one view that needs
 * no selection to say something true, so a stale link lands somewhere that
 * explains the server rather than on a screen asking for a peer the link
 * never named. `useRoute`'s own `isKnownHash` is what additionally fixes
 * the ADDRESS BAR for this case; this function only fixes what renders.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const slug = path.replace(/^\/+/, "");
  const view: Route["view"] = isRouteView(slug) ? slug : "overview";
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
