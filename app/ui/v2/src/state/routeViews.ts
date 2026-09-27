import type { Route } from "./useRoute";

/** Every slug this router answers to, in tab order -- kept in ONE place
 *  (round-3 style finding: this used to be a private const inside
 *  `useRoute.ts`, read by both `parseRoute` and `useRoute`'s own
 *  address-bar correction) so a view added to one and forgotten in the
 *  other cannot happen -- that mismatch is a dead tab. */
const VIEWS = ["overview", "explore", "messages", "forum", "knowledge"] as const;

export function isRouteView(slug: string): slug is Route["view"] {
  return (VIEWS as readonly string[]).includes(slug);
}
