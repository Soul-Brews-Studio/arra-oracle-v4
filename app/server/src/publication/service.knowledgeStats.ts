import { parseKnowledgeStats } from "./taxonomy.parseKnowledgeStats";
import { storedTimestamp } from "./taxonomy.storedTimestamp";
import { failTaxonomy } from "./taxonomy.failTaxonomy";
import { NODE_REVISIONS, NODES, SEARCH_CHUNKS, SUPERSEDE_LOG, TERMS, VOCABULARIES, scopeOf } from "./service.constants";
import { decimalOf } from "./service.decimalOf";
import { deriveNodeType } from "./service.deriveNodeType";
import { readHeadRevision } from "./service.readHeadRevision";
import { readTaxonomy } from "./service.readTaxonomy";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/**
 * Bounded scan window over `nodes`, matching `listNodes`' own
 * `MAX_SCANNED_NODES` and `service.listTermUsage.ts`'s copy of the same
 * bound: a workspace-wide aggregate with no keyset a caller can walk must
 * stay bounded on its own.
 */
const MAX_SCANNED_NODES = 1000;

/** Bounded scan window over `supersede_log`, one row per terminal node. */
const MAX_SCANNED_SUPERSEDE_ROWS = 2000;

/** Bounded scan window over `search_chunks_v1`. */
const MAX_SCANNED_CHUNKS = 5000;

export type KnowledgeStats = {
  nodes_total: string;
  /** null when the supersede_log scan could not see the whole workspace: an
   *  honest "not measured", never an approximation presented as exact. */
  nodes_eligible: string | null;
  by_type: { term: string; count: string }[] | null;
  chunks: { embedding_profile: string; status: string; count: string }[] | null;
  vocabularies: string;
  terms: string;
  last_updated_at: string | null;
};

/**
 * K7 (docs/overnight/V3-PARITY.md §5): node/revision/type/chunk/taxonomy
 * counts for one workspace. Every count is either the SDK's own native
 * `countRows` (exact, unbounded) or a bounded scan that discloses `null`
 * the moment it cannot see the whole workspace -- "measured not guessed",
 * never an approximation dressed up as a real number (the same rule R4's
 * `coverage` and R14's ngram fallback already apply to other reads).
 */
export async function knowledgeStats(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<KnowledgeStats> {
  return readTaxonomy(async () => {
    const request = parseKnowledgeStats(requestBytes);
    // A granted bank with no `workspaces` row is `invalid_reference`, the
    // same answer `listNodes`/`listPeers`/`listSessions` give, never a
    // workspace of exact-looking zeros (second fix round).
    await requireWorkspace(reader, request.workspace_name);
    const scope = scopeOf(request.workspace_name);

    await reader.refresh(NODES);
    const nodesTotalCount = await reader.count(NODES, scope);
    const nodes_total = decimalOf(nodesTotalCount);

    // One scan window serves BOTH by_type and last_updated_at: exhaustive
    // (not truncated) means it covers every node in the workspace, so a
    // max taken inside it is the real max, and a per-type tally inside it
    // is the real tally. Truncated means neither claim can be made, so
    // both come back null rather than a partial count/max presented whole.
    const scanned = await reader.orderedProjection(
      NODES,
      scope,
      ["id", "current_revision_id", "updated_at"],
      { column: "id", ascending: true },
      MAX_SCANNED_NODES + 1,
    );
    const nodesExhausted = scanned.length <= MAX_SCANNED_NODES;
    const window = scanned.slice(0, MAX_SCANNED_NODES);

    let last_updated_at: string | null = null;
    let by_type: { term: string; count: string }[] | null = null;
    if (nodesExhausted) {
      let max: bigint | null = null;
      for (const row of window) {
        const updatedAt = row.updated_at;
        if (typeof updatedAt !== "bigint") failTaxonomy("integrity_failure");
        if (max === null || updatedAt > max) max = updatedAt;
      }
      last_updated_at = max === null ? null : storedTimestamp(max);

      await reader.refresh(NODE_REVISIONS);
      const counts = new Map<string, bigint>();
      for (const node of window) {
        const term = deriveNodeType(await readHeadRevision(reader, scope, node.current_revision_id));
        counts.set(term, (counts.get(term) ?? 0n) + 1n);
      }
      by_type = [...counts.entries()]
        .map(([term, count]) => ({ term, count: count.toString(10) }))
        .sort((a, b) => a.term.localeCompare(b.term));
    }

    await reader.refresh(SUPERSEDE_LOG);
    const supersedeRows = await reader.query(SUPERSEDE_LOG, scope, MAX_SCANNED_SUPERSEDE_ROWS + 1);
    let nodes_eligible: string | null = null;
    if (supersedeRows.length <= MAX_SCANNED_SUPERSEDE_ROWS) {
      const terminal = new Set<string>();
      for (const row of supersedeRows) {
        const oldId = row.old_id;
        if (typeof oldId !== "string") failTaxonomy("integrity_failure");
        terminal.add(oldId);
      }
      const total = BigInt(nodes_total);
      const eligible = total - BigInt(terminal.size);
      nodes_eligible = eligible < 0n ? failTaxonomy("integrity_failure") : eligible.toString(10);
    }

    await reader.refresh(SEARCH_CHUNKS);
    const chunkRows = await reader.query(SEARCH_CHUNKS, scope, MAX_SCANNED_CHUNKS + 1);
    let chunks: { embedding_profile: string; status: string; count: string }[] | null = null;
    if (chunkRows.length <= MAX_SCANNED_CHUNKS) {
      const counts = new Map<string, { embedding_profile: string; status: string; count: bigint }>();
      for (const row of chunkRows) {
        const profile = row.embedding_profile;
        const status = row.status;
        if (typeof profile !== "string" || typeof status !== "string") failTaxonomy("integrity_failure");
        const key = `${profile}\u0000${status}`;
        const existing = counts.get(key);
        if (existing === undefined) counts.set(key, { embedding_profile: profile, status, count: 1n });
        else existing.count += 1n;
      }
      chunks = [...counts.values()]
        .map((v) => ({ embedding_profile: v.embedding_profile, status: v.status, count: v.count.toString(10) }))
        .sort((a, b) => (a.embedding_profile === b.embedding_profile ? a.status.localeCompare(b.status) : a.embedding_profile.localeCompare(b.embedding_profile)));
    }

    await reader.refresh(VOCABULARIES);
    const vocabularies = decimalOf(await reader.count(VOCABULARIES, scope));
    await reader.refresh(TERMS);
    const terms = decimalOf(await reader.count(TERMS, scope));

    return { nodes_total, nodes_eligible, by_type, chunks, vocabularies, terms, last_updated_at };
  });
}
