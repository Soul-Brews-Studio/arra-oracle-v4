import type { Route } from "./useRoute";

/** Where clicking a search hit should land: the EXISTING node view
 *  (`KnowledgeView`, `#/knowledge?node=…`) -- not Explore's own "nodes" tab.
 *
 * Fix-round finding (blocking): the previous handler only selected the hit
 * in Explore's paged node list and switched tabs there. That tab renders a
 * type filter and a 50-row page of `listNodes`, never the node's title,
 * body or revision history -- and if the hit sits past the first page, or a
 * type filter excludes it, the click leaves nothing highlighted at all.
 * `KnowledgeView` is the "existing node view" the brief means: it always
 * renders `NodeHead` + `RevisionHistory` for whatever id is in the URL,
 * independent of any list or filter.
 */
export function searchHitRoute(nodeId: string): Partial<Route> {
  return { view: "knowledge", node: nodeId };
}
