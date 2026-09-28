import { requestBytes } from "./db.legacyRead.requestBytes";
import { openTarget19MemoryReader } from "./db.legacyRead.openTarget19MemoryReader";
import { mapAcceptedHeadToMemory, type LegacyMemoryRow } from "./db.legacyRead.mapAcceptedHeadToMemory";
import { type FtsResult } from "./fts/fts";

/**
 * Target-19-backed `db.searchText`: `searchKnowledgeKeyword` (the #30 R14
 * ngram FTS over `search_chunks_v1`, Thai included) supplies matching node
 * ids; each is resolved to the legacy row shape through the same
 * `getAcceptedHead` path `db.legacyRead.getById` uses. `match` is the exact
 * `FtsResult` contract `db.searchText.ts` already uses (`"ngram"` |
 * `"substring_scan"`, from the one shared `fts.constants.ts` (R14/R7)).
 */
export async function searchText(q: string, bank: string, limit = 10): Promise<FtsResult<LegacyMemoryRow>> {
  const bundle = await openTarget19MemoryReader();
  const result = (await bundle.context.searchKnowledgeKeyword(
    requestBytes({ workspace_name: bank, query: q, limit }),
    Date.now(),
  )) as { match: "ngram" | "substring_scan"; hits: Array<{ node_id: string }> };

  const rows: LegacyMemoryRow[] = [];
  for (const hit of result.hits) {
    const found = (await bundle.publication.getAcceptedHead(
      requestBytes({ workspace_name: bank, node_id: hit.node_id }),
    )) as { node: Record<string, unknown>; revision: Record<string, unknown>; lifecycle: { kind: string; new_id: string | null } | null } | null;
    if (found === null) continue;
    rows.push(mapAcceptedHeadToMemory(found));
  }
  return { match: result.match, rows };
}
