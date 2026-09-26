import type { RankedChunk } from "./search-chunk.rankedChunk";
import { searchSnippet } from "./search-chunk.searchSnippet";

/** A node's captured head, as a hit reports it. */
export type HitHead = { revision_id: string; title: string };

export type KnowledgeHit = {
  node_id: string;
  revision_id: string;
  title: string;
  snippet: string;
  /** Every examined candidate chunk of the head revision, by chunk_index. */
  chunk_ids: string[];
  /** The node's best chunk rank; null for the unranked substring scan. */
  rank: number | null;
};

const byIndexThenId = (a: RankedChunk, b: RankedChunk) =>
  a.chunk_index < b.chunk_index ? -1 : a.chunk_index > b.chunk_index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Collapse ALREADY-VERIFIED current chunks into one hit per node.
 *
 * The caller has kept only chunks of each node's head revision on a
 * recall-eligible node (`heads` names exactly those); a chunk of any other
 * revision is dropped here too, as a second belt. A node ranks by its BEST
 * chunk -- the highest score (`descending`) or the smallest distance
 * (`ascending`) -- and that chunk is the snippet. Order is total and stable:
 * rank, then node id, so equal ranks and the unranked scan both fall back to
 * node id.
 */
export function groupKnowledgeHits(
  chunks: readonly RankedChunk[],
  heads: ReadonlyMap<string, HitHead>,
  order: "descending" | "ascending",
  snippetQuery: string | null,
): KnowledgeHit[] {
  const better = (a: number | null, b: number | null) =>
    a !== null && b !== null && (order === "descending" ? a > b : a < b);
  const byNode = new Map<string, RankedChunk[]>();
  for (const chunk of chunks) {
    if (heads.get(chunk.node_id)?.revision_id !== chunk.revision_id) continue;
    const group = byNode.get(chunk.node_id) ?? [];
    if (!group.some((seen) => seen.id === chunk.id)) group.push(chunk);
    byNode.set(chunk.node_id, group);
  }
  const hits: KnowledgeHit[] = [];
  for (const [nodeId, group] of byNode) {
    group.sort(byIndexThenId);
    let best = group[0]!;
    for (const chunk of group) if (better(chunk.rank, best.rank)) best = chunk;
    const head = heads.get(nodeId)!;
    hits.push({
      node_id: nodeId,
      revision_id: head.revision_id,
      title: head.title,
      snippet: searchSnippet(best.text, snippetQuery),
      chunk_ids: group.map((chunk) => chunk.id),
      rank: best.rank,
    });
  }
  return hits.sort((a, b) => (better(a.rank, b.rank) ? -1 : better(b.rank, a.rank) ? 1 : a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0));
}
