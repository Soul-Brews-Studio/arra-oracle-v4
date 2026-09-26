import { failPublication } from "./errors";
import {
  CHUNKER_VERSION,
  MAX_RECONCILE_REVISIONS,
  activeEmbeddingProfileId,
  chunkSourceText,
  chunkText,
  deriveChunkId,
  deriveContentHash,
  parseReconcileSearch,
} from "./search-chunk";
import { quote } from "./storage";
import { SEARCH_CHUNKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { terminalEventsFor } from "./service.terminalEventsFor";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { selectAcceptedRevision } from "./service.selectAcceptedRevision";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

export type ReconcileSearchChunksResult = {
  visited: number;
  missing: number;
  incomplete: number;
  hash_mismatch: number;
  missing_revisions: { node_id: string; revision_id: string }[];
  stale: number;
  /** #29 slice B (overnight R7): retired or superseded nodes visited on
   *  this page, counted SEPARATELY from `missing` -- DESIGN.md:1119's
   *  "stale vectors never present superseded content as current truth"
   *  means a terminal node's absent chunks are not a gap to backfill,
   *  they are correctly not indexed. Never queued via `missing_revisions`. */
  ineligible: number;
  missing_source: number;
  pending: number;
  ready: number;
  failed: number;
  exhausted: boolean;
};

/**
 * #30 R7 correctness pass over the earlier `limit 1` presence probe:
 *
 * - Presence is scoped to `(revision_id, CHUNKER_VERSION, active profile)`,
 *   not "any row under this revision" -- a revision indexed only under a
 *   retired or otherwise non-active profile id must count as missing for the
 *   ACTIVE one, the same way a never-indexed revision does.
 * - The expected chunk set is RECOMPUTED from the head's own title/body
 *   (`chunkText`/`deriveChunkId`/`deriveContentHash`, the exact derivation
 *   `indexRevisionChunks.ts` uses), so a PARTIAL set (`incomplete`) and a
 *   set whose stored `content_hash` no longer matches the recomputed one
 *   (`hash_mismatch`) are each their own signal, not folded into "missing".
 * - The stale probe runs for every visited, eligible node UNCONDITIONALLY --
 *   the previous version's `continue` on a missing revision skipped it
 *   whenever the head itself was unindexed, which is exactly the case a
 *   superseding publish produces (measured: analysis-30 op8). Missing and
 *   stale are independent facts about the same node and neither should
 *   suppress the other.
 * - A node with a `supersede_log` row naming it as `old_id` -- retired OR
 *   superseded, `getRecallEligibility`'s own check -- is `ineligible`: its
 *   content is not expected to be currently indexed, so it is excluded from
 *   missing/incomplete/hash_mismatch/stale accounting entirely rather than
 *   reported as a gap. Its head still counts as a legitimate revision for
 *   `missing_source` below, since chunks indexed before retirement are not
 *   "orphaned" by that alone. The terminal events of the whole visited page
 *   are read in ONE `old_id IN (...)` query (`terminalEventsFor`, #29 slice
 *   B's batching rule, analysis-29.json fix plan B1/B5), never one per node.
 * - `missing_source` is a GLOBAL count, bounded by this sweep: chunk rows
 *   (scoped to workspace/chunker/active profile) whose `node_id` was not
 *   among the visited nodes, or whose `revision_id` is not any visited
 *   node's accepted head. This can overlap with `stale` (a stale row IS a
 *   row off its own node's current head) -- the two are computed
 *   independently and both reported, rather than one suppressing the other.
 * - `pending`/`ready`/`failed` are workspace/chunker/active-profile counts
 *   across the whole scope, matching `getSearchFreshness`'s vector counts,
 *   so the two methods never present divergent numbers for the same facts.
 */
export async function reconcileSearchChunks(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: { clock: Clock; sourceNamespace: string | null },
  requestBytes: Uint8Array,
): Promise<ReconcileSearchChunksResult> {
  const request = parseReconcileSearch(requestBytes);
  await requireContextWorkspaceRow(writer, request.workspace_name);
  await writer.refresh("nodes");
  const fetched = await writer.orderedProjection(
    "nodes",
    contextScope(request.workspace_name),
    ["id"],
    { column: "id", ascending: true },
    request.limit + 1,
  );
  const visited = fetched.slice(0, request.limit);
  // Defensive, not reachable through the grammar today: `request.limit`
  // is already capped at MAX_RECONCILE_REVISIONS by parseReconcileSearch.
  // Kept as the documented bounded exception's own hard stop, in case
  // that cap is ever loosened without this one moving too.
  if (visited.length > MAX_RECONCILE_REVISIONS) failPublication("limit_exceeded", "");

  await writer.refresh("node_revisions");
  await writer.refresh(SEARCH_CHUNKS);

  const scope = contextScope(request.workspace_name);
  const profileId = activeEmbeddingProfileId();

  const visitedIds = visited.map((row) => {
    const nodeId = row.id;
    if (typeof nodeId !== "string") failPublication("integrity_failure", "");
    return nodeId;
  });
  // ONE `supersede_log` query for the whole visited page, not one per node
  // (same batching rule as `listNodes`, analysis-29.json fix plan B1/B5).
  const terminal = await terminalEventsFor(writer, request.workspace_name, visitedIds);

  let missing = 0;
  let incomplete = 0;
  let hashMismatch = 0;
  let stale = 0;
  let ineligible = 0;
  const missingRevisions: { node_id: string; revision_id: string }[] = [];
  // Every visited node's own accepted head, INCLUDING ineligible ones: a row
  // indexed before a node was retired/superseded is legitimate history, not
  // an orphan `missing_source` should flag.
  const visitedNodeIds = new Set<string>();
  const acceptedHeads = new Set<string>();

  for (const nodeId of visitedIds) {
    visitedNodeIds.add(nodeId);
    const resolved = await selectAcceptedRevision(writer, request.workspace_name, nodeId, null);
    // Every node reached here was just selected FROM the nodes table, so
    // an unresolvable head is stored corruption, not a caller mistake.
    if (resolved === null) failPublication("integrity_failure", "");
    const revisionId = resolved.head;
    acceptedHeads.add(revisionId);

    // getRecallEligibility's own check: any supersede_log row naming this
    // node as old_id means retired OR superseded. Ineligible nodes are not
    // expected to have current chunks, so they are excluded from every
    // per-revision signal below.
    if (terminal.has(nodeId)) {
      ineligible += 1;
      continue;
    }

    const title = resolved.selected.title;
    const body = resolved.selected.body;
    if (typeof title !== "string" || typeof body !== "string") failPublication("integrity_failure", "");
    // The same string `indexRevisionChunks` cuts into chunks.
    const pieces = chunkText(chunkSourceText(title, body));
    const expected = pieces.map((piece, index) => ({
      id: deriveChunkId(revisionId, CHUNKER_VERSION, profileId, BigInt(index)),
      content_hash: deriveContentHash(piece),
    }));

    const present = await writer.query(
      SEARCH_CHUNKS,
      `${scope} AND revision_id = ${quote(revisionId)}` +
        ` AND chunker_version = ${quote(CHUNKER_VERSION)}` +
        ` AND embedding_profile = ${quote(profileId)}`,
    );
    if (present.length === 0) {
      missing += 1;
      missingRevisions.push({ node_id: nodeId, revision_id: revisionId });
    } else {
      const presentById = new Map(present.map((r) => [r.id as string, r]));
      let allPresent = true;
      let anyMismatch = false;
      for (const chunk of expected) {
        const stored = presentById.get(chunk.id);
        if (stored === undefined) {
          allPresent = false;
          continue;
        }
        if (stored.content_hash !== chunk.content_hash) anyMismatch = true;
      }
      if (!allPresent) {
        incomplete += 1;
        missingRevisions.push({ node_id: nodeId, revision_id: revisionId });
      }
      if (anyMismatch) hashMismatch += 1;
    }

    // STALE: chunk rows survive under this node for a revision that is no
    // longer the accepted head. Runs regardless of the missing/incomplete
    // outcome above -- never skipped, never deleted here (this method only
    // reports, it does not reclaim).
    const staleRows = await writer.query(
      SEARCH_CHUNKS,
      `${scope} AND node_id = ${quote(nodeId)} AND revision_id != ${quote(revisionId)}`,
      1,
    );
    if (staleRows.length > 0) stale += 1;
  }

  const profileScope =
    `${scope} AND chunker_version = ${quote(CHUNKER_VERSION)} AND embedding_profile = ${quote(profileId)}`;
  const [pending, ready, failed] = await Promise.all([
    writer.count(SEARCH_CHUNKS, `${profileScope} AND status = 'pending'`),
    writer.count(SEARCH_CHUNKS, `${profileScope} AND status = 'ready'`),
    writer.count(SEARCH_CHUNKS, `${profileScope} AND status = 'failed'`),
  ]);

  const missingSource =
    visitedNodeIds.size === 0
      ? await writer.count(SEARCH_CHUNKS, profileScope)
      : await writer.count(
          SEARCH_CHUNKS,
          `${profileScope} AND (node_id NOT IN (${[...visitedNodeIds].map(quote).join(", ")})` +
            ` OR revision_id NOT IN (${[...acceptedHeads].map(quote).join(", ")}))`,
        );

  return {
    visited: visited.length,
    missing,
    incomplete,
    hash_mismatch: hashMismatch,
    missing_revisions: missingRevisions,
    stale,
    ineligible,
    missing_source: missingSource,
    pending,
    ready,
    failed,
    exhausted: fetched.length <= request.limit,
  };
}
