import { failPublication } from "./errors";
import { encodeNodeRow } from "./rows";
import { type HitHead, type RankedChunk } from "./search-chunk";
import { quote } from "./storage";
import { NODE_REVISIONS, NODES } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { recallEligibleNodeIds } from "./service.recallEligibleNodeIds";
import { type DatasetAdapter } from "./service.types";

/** Node ids per `IN (...)` read: keeps each predicate small. */
const ID_BATCH = 256;

const inList = (ids: readonly string[]) => ids.map(quote).join(", ");
const batches = (ids: readonly string[]) =>
  Array.from({ length: Math.ceil(ids.length / ID_BATCH) }, (_, i) => ids.slice(i * ID_BATCH, (i + 1) * ID_BATCH));

/**
 * Keep only candidate chunks that ARE a current answer (#30 acceptance: "stale
 * vectors and superseded revisions cannot become current answers"):
 *
 * 1. the chunk's revision is its node's CAPTURED HEAD (`nodes.current_revision_id`)
 *    -- a chunk of any earlier revision is stale, however well it matched;
 * 2. the node is recall-eligible (`recallEligibleNodeIds`, the #29 seam) --
 *    retired and superseded nodes never surface;
 * 3. every read is scoped to `workspace`, so a chunk can only resolve against
 *    its own workspace's nodes. The candidate query is scoped too; this is
 *    the second belt, not the first.
 *
 * The copied `term_ids`/session columns on a chunk are never consulted here:
 * a stale projection is not an authorization or lifecycle source.
 *
 * Returns a filter for ONE search request: each call takes that round's
 * candidates and answers the survivors plus, for each surviving node, its head
 * `{revision_id, title}`. What it learns about a node (head, eligibility,
 * title) is remembered across the request's overfetch rounds, so no node is
 * looked up twice. A duplicated node or head row is `integrity_failure`,
 * never a pick.
 */
export function currentEligibleChunks(
  reader: DatasetAdapter,
  workspace: string,
): (chunks: readonly RankedChunk[]) => Promise<{ chunks: RankedChunk[]; heads: Map<string, HitHead> }> {
  const scope = contextScope(workspace);
  const memo = {
    /** node id -> captured head revision id, or null (no such node / no head). */
    heads: new Map<string, string | null>(),
    /** node id -> recall-eligible (the #29 seam's answer). */
    eligible: new Map<string, boolean>(),
    /** head revision id -> its title. */
    titles: new Map<string, string>(),
  };

  return async (chunks) => {
    const unknownNodes = [...new Set(chunks.map((chunk) => chunk.node_id))].filter((id) => !memo.heads.has(id));
    for (const batch of batches(unknownNodes)) {
      const rows = await reader.query(NODES, `${scope} AND id IN (${inList(batch)})`);
      for (const row of rows) {
        const node = encodeNodeRow(row);
        if (memo.heads.has(node.id as string)) failPublication("integrity_failure", "");
        memo.heads.set(node.id as string, node.current_revision_id as string | null);
      }
      for (const id of batch) if (!memo.heads.has(id)) memo.heads.set(id, null);
    }

    const atHead = chunks.filter((chunk) => chunk.revision_id === memo.heads.get(chunk.node_id));
    const unjudged = [...new Set(atHead.map((chunk) => chunk.node_id))].filter((id) => !memo.eligible.has(id));
    const eligible = await recallEligibleNodeIds(reader, workspace, unjudged);
    for (const id of unjudged) memo.eligible.set(id, eligible.has(id));
    const current = atHead.filter((chunk) => memo.eligible.get(chunk.node_id) === true);

    const untitled = [...new Set(current.map((chunk) => chunk.revision_id))].filter((id) => !memo.titles.has(id));
    for (const batch of batches(untitled)) {
      const rows = await reader.orderedProjection(
        NODE_REVISIONS,
        `${scope} AND id IN (${inList(batch)})`,
        ["id", "node_id", "title"],
        { column: "id", ascending: true },
        batch.length + 1,
      );
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.title !== "string") failPublication("integrity_failure", "");
        // A head row that belongs to another node, or appears twice, is corrupt.
        if (memo.titles.has(row.id) || memo.heads.get(row.node_id as string) !== row.id) failPublication("integrity_failure", "");
        memo.titles.set(row.id, row.title);
      }
      for (const id of batch) if (!memo.titles.has(id)) failPublication("integrity_failure", "");
    }

    const heads = new Map<string, HitHead>();
    for (const chunk of current) heads.set(chunk.node_id, { revision_id: chunk.revision_id, title: memo.titles.get(chunk.revision_id)! });
    return { chunks: current, heads };
  };
}
