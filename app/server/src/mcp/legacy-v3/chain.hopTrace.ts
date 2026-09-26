import type { Kb } from "./createKb";
import { randomId } from "./ids.randomId";
import type { RecallRow } from "./search.recall";

/**
 * Write one chain hop as one immutable trace (V3-PARITY.md §4.4
 * `oracle_search_chain`; trace-v1.md). v3 created the trace and then linked
 * it to the previous one with a mutable `next` edge; v4 traces are immutable,
 * so the link is `prev_id`, written once at creation (D11). `depth` is 0: a
 * chain is a `prev_id` sequence, not a `parent_id` tree (K13 ties depth to the
 * parent only). Each hop result is a `node_revision` hit at its rank; the hop
 * is `complete` when written. Returns the new trace id.
 */
export async function hopTrace(
  kb: Kb,
  hop: { index: number; query: string; rows: readonly RecallRow[]; prevId: string | null; peer: string | null; bestDistance: number },
): Promise<string> {
  const id = randomId();
  await kb("createTrace", {
    id,
    name: `oracle_search_chain hop ${hop.index}`,
    session_name: null,
    peer_name: hop.peer,
    query: hop.query,
    mode: "chain",
    session_id: null,
    session_from_ts: null,
    session_to_ts: null,
    friction_score: null,
    confidence: null,
    parent_id: null,
    prev_id: hop.prevId,
    depth: "0",
    status: "complete",
    h_metadata: null,
    internal_metadata: JSON.stringify({ created_by: "oracle_search_chain/arra-v3-compat/1", hop: hop.index, best_distance: hop.bestDistance }),
    hits: hop.rows.map(({ hit }, rank) => ({
      kind: "node_revision",
      target: { node_id: hit.node_id, revision_id: hit.revision_id },
      ref: `hop ${hop.index} rank ${rank + 1}`,
      line_start: null,
      line_end: null,
      excerpt: null,
      content_hash: null,
      captured_at: null,
      note: null,
    })),
  });
  return id;
}
