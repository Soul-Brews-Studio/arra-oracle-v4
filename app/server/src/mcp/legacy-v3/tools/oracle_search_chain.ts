import { hopTrace } from "../chain.hopTrace";
import { queryText } from "../chain.queryText";
import { CompatError } from "../compat-error";
import { ensureSpeaker } from "../ensureSpeaker";
import type { V3ToolContext } from "../handlers";
import { describeHead } from "../search.describeHead";
import type { CompatWarning } from "../search.parseFilters";
import { readCount } from "../search.readCount";
import type { RecallRow } from "../search.recall";
import { SEARCH_WINDOW, type KernelHit } from "../search.retrieve";
import { v3Result } from "../search.v3Result";

type Hop = { hop: number; query: string; sourceId: string | null; traceId: string; resultIds: string[]; bestId: string; bestScore: number; stoppedReason?: string };

/** v3 stopped when a hop's best score fell under half the previous one's (src/tools/search/chain.ts DEFAULT_SCORE_DECAY). */
const SCORE_DECAY = 0.5;

const isEmbedderDown = (error: unknown) =>
  (error as { code?: unknown })?.code === "writer_unavailable" && typeof (error as { toJSON?: unknown })?.toJSON === "function";

/**
 * `oracle_search_chain` (V3-PARITY.md §4.4; v3 src/tools/chain-search.ts,
 * src/tools/search/chain.ts). content:write: it writes one trace per hop.
 *
 * Hop 0 is a semantic search for the seed query. Each later hop searches by
 * the previous best entry's own text (`chain.queryText.ts`) -- v3 queried by
 * that entry's stored vector, which the v4 semantic kernel does not take --
 * skipping entries an earlier hop already returned. `score` is
 * `1/(1+distance)` (squared L2, as the kernel reports it); the chain stops on
 * no result, only revisits (`cycle_guard`), a best score under half the
 * previous hop's (`score_decay`), or `maxHops`. Each hop is written as an
 * immutable trace linked to the previous by `prev_id` (`chain.hopTrace.ts`),
 * attributed to the speaking peer when there is one. Superseded and retired
 * entries are never returned (D3, in the kernel).
 *
 * With no query embedder the chain cannot start: a `kernel_error` saying so,
 * with the v4 envelope, and no trace written. If the embedder stops answering
 * mid-chain, the hops already written stand and `partial` says where it stopped.
 */
export async function oracle_search_chain(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { tool, kb } = context;
  const seed = typeof args.query === "string" ? args.query.trim() : "";
  if (seed === "") throw new CompatError(tool, "unsupported_argument", "query is required", "v3's own rule: a nonblank query", { path: "/query" });
  const maxHops = readCount(tool, args, "maxHops", { fallback: 3, min: 1, max: SEARCH_WINDOW }).value;
  const breadth = readCount(tool, args, "breadth", { fallback: 5, min: 1, max: SEARCH_WINDOW }).value;
  const warnings: CompatWarning[] = [];
  if (args.model !== undefined && args.model !== null) warnings.push({ code: "argument_ignored", field: "model", detail: "the embedding model is the server's" });
  // The speaker is ensured (possibly registered: a write) only once a hop has
  // something to record, so a chain that cannot start writes nothing at all.
  let peer: string | null | undefined;

  const visited = new Set<string>();
  const results: Record<string, unknown>[] = [];
  const traceIds: string[] = [];
  const hops: Hop[] = [];
  let text = seed;
  let hopQuery = seed;
  let sourceId: string | null = null;
  let previousBest = Number.POSITIVE_INFINITY;

  for (let hop = 0; hop < maxHops; hop++) {
    let hits: KernelHit[];
    try {
      hits = ((await kb("searchKnowledgeSemantic", { query: text, limit: Math.min(SEARCH_WINDOW, breadth + visited.size) })) as { hits: KernelHit[] }).hits;
    } catch (error) {
      if (!isEmbedderDown(error)) throw error;
      if (hop === 0) {
        throw new CompatError(tool, "kernel_error", "Vector search unavailable: the query embedder did not answer",
          "oracle_search_chain is semantic only; retry when the embedder answers", { v4Error: (error as { toJSON(): unknown }).toJSON() });
      }
      warnings.push({ code: "partial", field: "hops", detail: `the query embedder stopped answering at hop ${hop}; earlier hops and their traces stand` });
      break;
    }
    const rows: RecallRow[] = [];
    for (const hit of hits.filter((h) => !visited.has(h.node_id)).slice(0, breadth)) {
      const facts = describeHead(await kb("getAcceptedHead", { node_id: hit.node_id }));
      if (facts !== null && facts.lifecycle === null) rows.push({ hit, facts });
    }
    const best = rows[0];
    if (best === undefined) {
      if (hops.length > 0) hops.at(-1)!.stoppedReason = hits.length > 0 ? "cycle_guard" : "no_results";
      break;
    }
    const bestScore = 1 / (1 + (best.hit.distance ?? 0));
    if (hop > 0 && bestScore < previousBest * SCORE_DECAY) {
      hops.at(-1)!.stoppedReason = "score_decay";
      break;
    }
    peer ??= await ensureSpeaker(context, args);
    const traceId = await hopTrace(kb, { index: hop, query: hopQuery, rows, prevId: traceIds.at(-1) ?? null, peer, bestDistance: best.hit.distance ?? 0 });
    for (const row of rows) {
      visited.add(row.hit.node_id);
      results.push({ ...v3Result(row, results.length, "vector"), score: 1 / (1 + (row.hit.distance ?? 0)), distance: row.hit.distance ?? null, model: null });
    }
    traceIds.push(traceId);
    hops.push({ hop, query: hopQuery, sourceId, traceId, resultIds: rows.map((row) => row.hit.node_id), bestId: best.hit.node_id, bestScore, ...(hop === maxHops - 1 ? { stoppedReason: "max_hops" } : {}) });
    previousBest = bestScore;
    sourceId = best.hit.node_id;
    hopQuery = best.hit.node_id;
    text = queryText(best.facts);
  }
  if (hops.length > 0 && hops.at(-1)!.stoppedReason === undefined) hops.at(-1)!.stoppedReason = "no_results";

  if (results.length > 0) warnings.push({ code: "field_unavailable", field: "source_file", detail: "v4 writes no file; each result is a node (see id)" });
  warnings.push({ code: "field_unavailable", field: "model", detail: "the server's embedding profile answered; it is not one of v3's model keys" });
  warnings.push({ code: "semantic_change", field: "hops", detail: "later hops search by the best entry's text, re-embedded, not by its stored vector; each hop's trace is linked by prev_id at creation, not by a later edge" });
  return { query: seed, maxHops, breadth, model: null, traceIds, hops, results, compat_warnings: warnings };
}
