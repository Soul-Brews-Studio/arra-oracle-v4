import { snapshotText } from "./association.snapshotText";
import { parseListTermUsage } from "./taxonomy.parseListTermUsage";
import { failTaxonomy } from "./taxonomy.failTaxonomy";
import { NODE_REVISIONS, NODES, scopeOf } from "./service.constants";
import { deriveNodeType } from "./service.deriveNodeType";
import { parseSnapshotArray } from "./service.parseSnapshotArray";
import { readHeadRevision } from "./service.readHeadRevision";
import { readTaxonomy } from "./service.readTaxonomy";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/**
 * Bounded scan window over `nodes`, matching `listNodes`' own
 * `MAX_SCANNED_NODES` (service.listNodes.ts): this is a workspace-wide
 * aggregate with no keyset a caller can walk, so it must stay bounded on its
 * own rather than growing unboundedly with the workspace.
 */
const MAX_SCANNED_NODES = 1000;

export type TermUsageRow = { term_id: string; name: string; count: string };
export type TermUsageResult = { rows: TermUsageRow[]; total_unique: string; coverage: "full" | "partial" };

/**
 * K6 (docs/overnight/V3-PARITY.md §5): how many CURRENT heads reference each
 * term of one vocabulary, counted from each accepted head revision's own
 * `term_snapshot_json` -- the authoritative record, written WITH the
 * revision in the same accepted publish -- never from the derived
 * `node_revision_terms` projection.
 *
 * Second fix round (an independent verifier's blocking finding): the first
 * two cuts of this method counted `node_revision_terms` rows. That table only
 * exists for a revision once `reconcileRevisionAssociations` has run for it,
 * and no ordinary writer runs it -- not `kb_publishRevision`, not HTTP
 * `publishRevision`, not the v4 UI -- so every such head was silently left
 * out while `coverage` still said "full", with nothing on the wire to tell
 * that apart from a real zero. `association-evidence-v1.md` §4 already forbids
 * exactly this ("Do not answer completeness from projection candidates"),
 * and `listNodes`' `type_term` filter already avoids the table for the same
 * reason. Reading the snapshot costs one point read per head: the same read
 * `listNodes`' `type_term` filter and `knowledgeStats`' `by_type` already pay.
 * In exchange no writer can make this count wrong by skipping a step, and a
 * stale or partial projection cannot change it either.
 *
 * `coverage` therefore means exactly one thing: whether the bounded node
 * window saw every node of the workspace. "partial" is the same honesty rule
 * `listNodes`' `type_term`-filtered `total` and the #10/R14 ngram fallback
 * already use: a bounded scan that hits its cap says so instead of silently
 * presenting a partial count as exact.
 */
export async function listTermUsage(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<TermUsageResult> {
  return readTaxonomy(async () => {
    const request = parseListTermUsage(requestBytes);
    await requireWorkspace(reader, request.workspace_name);
    const scope = scopeOf(request.workspace_name);

    await reader.refresh(NODES);
    const scanned = await reader.orderedProjection(
      NODES,
      scope,
      ["id", "current_revision_id"],
      { column: "id", ascending: true },
      MAX_SCANNED_NODES + 1,
    );
    const nodesTruncated = scanned.length > MAX_SCANNED_NODES;

    await reader.refresh(NODE_REVISIONS);
    const counts = new Map<string, { name: string; count: bigint }>();
    for (const node of scanned.slice(0, MAX_SCANNED_NODES)) {
      const head = await readHeadRevision(reader, scope, node.current_revision_id);
      // The node's type comes from the SAME snapshot, through the same
      // decoder `listNodes`' `type_term` filter uses.
      if (request.type_term !== null && deriveNodeType(head) !== request.type_term) continue;

      const seen = new Set<string>();
      for (const entry of parseSnapshotArray(head.term_snapshot_json, "")) {
        if (entry === null || typeof entry !== "object") failTaxonomy("integrity_failure");
        if (snapshotText(entry.vocabulary_id) !== request.vocabulary_id) continue;
        const termId = snapshotText(entry.term_id);
        const termName = snapshotText(entry.term_name_snapshot);
        // Publication refuses a duplicate term_id in one snapshot
        // (`contracts/revision-v1.ts`), so a stored one is corruption, not a
        // head that references the term twice.
        if (seen.has(termId)) failTaxonomy("integrity_failure");
        seen.add(termId);
        const existing = counts.get(termId);
        if (existing === undefined) counts.set(termId, { name: termName, count: 1n });
        else existing.count += 1n;
      }
    }

    const ranked = [...counts.entries()]
      .map(([term_id, v]) => ({ term_id, name: v.name, count: v.count }))
      .sort((a, b) => (b.count === a.count ? a.name.localeCompare(b.name) : Number(b.count - a.count)));

    return {
      rows: ranked.slice(0, request.limit).map((r) => ({ term_id: r.term_id, name: r.name, count: r.count.toString(10) })),
      total_unique: BigInt(counts.size).toString(10),
      coverage: nodesTruncated ? "partial" : "full",
    };
  });
}
