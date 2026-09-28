import { requestBytes } from "./db.legacyRead.requestBytes";
import { openTarget19MemoryReader } from "./db.legacyRead.openTarget19MemoryReader";
import { mapAcceptedHeadToMemory, type LegacyMemoryRow } from "./db.legacyRead.mapAcceptedHeadToMemory";

/**
 * Target-19-backed `db.searchVector`: `searchKnowledgeSemantic` (the #30
 * nearest-chunk vector search over `search_chunks_v1`, one embedding profile,
 * `l2_squared`) supplies matching node ids in distance order; each is
 * resolved to the legacy row shape through the same `getAcceptedHead` path
 * `db.legacyRead.getById` uses.
 */
export async function searchVector(q: string, bank: string, limit = 10): Promise<LegacyMemoryRow[]> {
  const bundle = await openTarget19MemoryReader();
  const result = (await bundle.context.searchKnowledgeSemantic(
    requestBytes({ workspace_name: bank, query: q, limit }),
    Date.now(),
  )) as { hits: Array<{ node_id: string }> };

  const rows: LegacyMemoryRow[] = [];
  for (const hit of result.hits) {
    const found = (await bundle.publication.getAcceptedHead(
      requestBytes({ workspace_name: bank, node_id: hit.node_id }),
    )) as { node: Record<string, unknown>; revision: Record<string, unknown>; lifecycle: { kind: string; new_id: string | null } | null } | null;
    if (found === null) continue;
    rows.push(mapAcceptedHeadToMemory(found));
  }
  return rows;
}
