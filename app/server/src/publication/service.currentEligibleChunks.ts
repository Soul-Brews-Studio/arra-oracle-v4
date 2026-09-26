import { containsFolded } from "../fts/fts";
import { failPublication } from "./errors";
import { encodeNodeRow } from "./rows";
import { chunkSourceText, type HitHead, type RankedChunk } from "./search-chunk";
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
const unique = (ids: readonly string[]) => [...new Set(ids)];

/** What one request learned about a head revision. */
type HeadRevision = { title: string; text: string | undefined; matches: boolean };

/**
 * Keep only candidate chunks that ARE a current answer (#30 acceptance: "stale
 * vectors and superseded revisions cannot become current answers"):
 *
 * 1. the chunk's revision is its node's CAPTURED HEAD (`nodes.current_revision_id`)
 *    -- a chunk of any earlier revision is stale, however well it matched;
 * 2. with a `query` (keyword search): the head revision's WHOLE text
 *    (`chunkSourceText`, the string its chunks were cut from) contains it,
 *    case-folded (`containsFolded`). This is the substring contract, and it is
 *    checked on the revision, never on one chunk: an occurrence cut by a chunk
 *    boundary, or longer than a chunk, is still an answer;
 * 3. the node is recall-eligible (`recallEligibleNodeIds`, the #29 seam) --
 *    retired and superseded nodes never surface. Asked last, and only for
 *    nodes that survived 1 and 2, because it costs several reads per node;
 * 4. every read is scoped to `workspace`, so a chunk can only resolve against
 *    its own workspace's nodes. The candidate query is scoped too; this is
 *    the second belt, not the first.
 *
 * The copied `term_ids`/session columns on a chunk are never consulted here:
 * a stale projection is not an authorization or lifecycle source.
 *
 * Returns a filter for ONE search request: each call takes that round's
 * candidates and answers the survivors plus, for each surviving node, its head
 * `{revision_id, title}` (and `text`, with a query). What it learns about a
 * node (head, text match, eligibility, title) is remembered across the
 * request's overfetch rounds, so nothing is looked up twice. A duplicated node
 * or head row is `integrity_failure`, never a pick.
 */
export function currentEligibleChunks(
  reader: DatasetAdapter,
  workspace: string,
  query: string | null,
): (chunks: readonly RankedChunk[]) => Promise<{ chunks: RankedChunk[]; heads: Map<string, HitHead> }> {
  const scope = contextScope(workspace);
  const memo = {
    /** node id -> captured head revision id, or null (no such node / no head). */
    heads: new Map<string, string | null>(),
    /** head revision id -> its title and, with a query, whether it matches. */
    revisions: new Map<string, HeadRevision>(),
    /** node id -> recall-eligible (the #29 seam's answer). */
    eligible: new Map<string, boolean>(),
  };
  const columns = query === null ? ["id", "node_id", "title"] : ["id", "node_id", "title", "body"];

  return async (chunks) => {
    const unknownNodes = unique(chunks.map((chunk) => chunk.node_id)).filter((id) => !memo.heads.has(id));
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

    const unread = unique(atHead.map((chunk) => chunk.revision_id)).filter((id) => !memo.revisions.has(id));
    for (const batch of batches(unread)) {
      const rows = await reader.orderedProjection(
        NODE_REVISIONS,
        `${scope} AND id IN (${inList(batch)})`,
        columns,
        { column: "id", ascending: true },
        batch.length + 1,
      );
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.title !== "string") failPublication("integrity_failure", "");
        if (query !== null && typeof row.body !== "string") failPublication("integrity_failure", "");
        // A head row that belongs to another node, or appears twice, is corrupt.
        if (memo.revisions.has(row.id) || memo.heads.get(row.node_id as string) !== row.id) failPublication("integrity_failure", "");
        const text = query === null ? undefined : chunkSourceText(row.title, row.body as string);
        const matches = text === undefined || containsFolded(text, query!);
        // Only a matching head's text is kept: it is the hit's snippet source.
        memo.revisions.set(row.id, { title: row.title, text: matches ? text : undefined, matches });
      }
      for (const id of batch) if (!memo.revisions.has(id)) failPublication("integrity_failure", "");
    }
    const matching = atHead.filter((chunk) => memo.revisions.get(chunk.revision_id)!.matches);

    const unjudged = unique(matching.map((chunk) => chunk.node_id)).filter((id) => !memo.eligible.has(id));
    const eligible = await recallEligibleNodeIds(reader, workspace, unjudged);
    for (const id of unjudged) memo.eligible.set(id, eligible.has(id));
    const current = matching.filter((chunk) => memo.eligible.get(chunk.node_id) === true);

    const heads = new Map<string, HitHead>();
    for (const chunk of current) {
      const revision = memo.revisions.get(chunk.revision_id)!;
      heads.set(chunk.node_id, {
        revision_id: chunk.revision_id,
        title: revision.title,
        ...(revision.text === undefined ? {} : { text: revision.text }),
      });
    }
    return { chunks: current, heads };
  };
}
