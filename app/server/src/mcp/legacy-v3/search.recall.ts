import type { Kb } from "./createKb";
import { describeHead, type HeadFacts } from "./search.describeHead";
import { retrieve, type KernelHit, type Retrieved } from "./search.retrieve";

export type RecallRequest = {
  query: string;
  mode: "fts" | "vector";
  /** v3 `type` filter, or null for all. */
  type: string | null;
  /** normalized v3 `project` filter, or null for none. */
  project: string | null;
  /** How many leading matches the caller will show (offset + limit). */
  want: number;
};

export type RecallRow = { hit: KernelHit; facts: HeadFacts };

/**
 * The shared recall path of `oracle_search` and `oracle_ask` (V3-PARITY.md
 * §4.4, A5, A6): one retrieval (`search.retrieve.ts`), then each shown node's
 * accepted head for v3's `type`, `content` and `concepts`.
 *
 * v3's filters run here, on the head's term snapshot, because the kernel
 * search takes none: `type` is v3's type string (A5), and `project` P keeps P
 * plus `_universal` plus entries with no project at all, v3's
 * `project = P OR project IS NULL` (arra-oracle-v3 src/tools/search/fts.ts:24).
 * With a filter every match in the window is read; without one, only the
 * first `want`. `total` counts matches in the window (a lower bound when
 * `retrieved.saturated`).
 *
 * D3 is the kernel's: it answers recall-eligible heads only. A node found
 * retired or superseded when its head is read (a lifecycle event between the
 * two reads) is dropped as well, never shown.
 */
export async function recall(kb: Kb, request: RecallRequest): Promise<{ retrieved: Retrieved; rows: RecallRow[]; total: number }> {
  const retrieved = await retrieve(kb, request.query, request.mode);
  const filtered = request.type !== null || request.project !== null;
  const keep = (facts: HeadFacts) =>
    (request.type === null || facts.v3Type === request.type) &&
    (request.project === null || facts.project === null || facts.project === request.project || facts.project === "_universal");

  const rows: RecallRow[] = [];
  let dropped = 0;
  for (const hit of retrieved.hits) {
    if (!filtered && rows.length >= request.want) break;
    const facts = describeHead(await kb("getAcceptedHead", { node_id: hit.node_id }));
    if (facts === null || facts.lifecycle !== null || !keep(facts)) {
      dropped += 1;
      continue;
    }
    rows.push({ hit, facts });
  }
  return { retrieved, rows, total: filtered ? rows.length : retrieved.hits.length - dropped };
}
