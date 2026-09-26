import type { RankedChunk } from "./search-chunk.rankedChunk";
import { searchSnippet } from "./search-chunk.searchSnippet";

/**
 * A node's captured head, as a hit reports it. `text` is the head's whole
 * chunk source text (`chunkSourceText`) when the caller read it -- keyword
 * search does, to re-check the hit -- and the snippet is then cut from it, so
 * an occurrence split across two chunks still shows whole. Keyword search
 * also reads overnight R22's ordering keys with it (`KeywordOrderKey`):
 * `occurrences` of the query in `text`, and the head's `accepted_at`.
 */
export type HitHead = { revision_id: string; title: string; text?: string; occurrences?: number; accepted_at?: bigint };

export type KnowledgeHit = {
  node_id: string;
  revision_id: string;
  title: string;
  snippet: string;
  /** Every examined candidate chunk of the head revision, by chunk_index. */
  chunk_ids: string[];
  /** The node's best chunk rank; null for a hit no ranked source found. */
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
 * (`ascending`); a ranked chunk beats an unranked one. That chunk is the
 * snippet's source, unless the head carries its whole text. Order is total and
 * stable: ranked hits by rank, then every unranked hit (the scans), each tie
 * broken by node id. Keyword search passes no rank at all and re-sorts the
 * hits by `keywordHitOrder` (overnight R22); semantic search keeps this order.
 */
export function groupKnowledgeHits(
  chunks: readonly RankedChunk[],
  heads: ReadonlyMap<string, HitHead>,
  order: "descending" | "ascending",
  snippetQuery: string | null,
): KnowledgeHit[] {
  /** Negative when rank `a` is better than rank `b`; null is worst. */
  const byRank = (a: number | null, b: number | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : (order === "descending" ? a > b : a < b) ? -1 : 1;
  const byNode = new Map<string, RankedChunk[]>();
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (heads.get(chunk.node_id)?.revision_id !== chunk.revision_id || seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    const group = byNode.get(chunk.node_id) ?? [];
    group.push(chunk);
    byNode.set(chunk.node_id, group);
  }
  const hits: KnowledgeHit[] = [];
  for (const [nodeId, group] of byNode) {
    group.sort(byIndexThenId);
    let best = group[0]!;
    for (const chunk of group) if (byRank(chunk.rank, best.rank) < 0) best = chunk;
    const head = heads.get(nodeId)!;
    hits.push({
      node_id: nodeId,
      revision_id: head.revision_id,
      title: head.title,
      snippet: searchSnippet(head.text ?? best.text, snippetQuery),
      chunk_ids: group.map((chunk) => chunk.id),
      rank: best.rank,
    });
  }
  return hits.sort((a, b) => byRank(a.rank, b.rank) || (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0));
}
