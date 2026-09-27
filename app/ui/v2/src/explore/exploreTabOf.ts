import { EXPLORE_TABS, type ExploreTab } from "./DetailTabs";

/** The Explore detail tab a route's `tab` param names -- or "nodes" when it
 *  names none. `parseRoute` passes `tab` through unchecked, so a stale link
 *  or a hand-typed `&tab=Nodes` (the labels are CSS-capitalised, so that is
 *  a natural guess) used to reach `DetailTabs` as-is: no tab selected, no
 *  panel rendered, and -- before `TabStrip` fell back to its first tab -- no
 *  tab stop either (ui-keys fix round, #33 AC2). Coerced here, once, so the
 *  strip, the tabpanel and the panel body all agree on what is open. The
 *  URL keeps the bad value until the next tab change writes a real one. */
export function exploreTabOf(tab: string | null): ExploreTab {
  return EXPLORE_TABS.find((t) => t === tab) ?? "nodes";
}
