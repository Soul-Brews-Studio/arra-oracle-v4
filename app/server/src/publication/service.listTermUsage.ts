import { quote } from "./storage";
import { parseListTermUsage } from "./taxonomy.parseListTermUsage";
import { failTaxonomy } from "./taxonomy.failTaxonomy";
import { NODE_REVISIONS, NODES, TERMS_TABLE, scopeOf } from "./service.constants";
import { deriveNodeType } from "./service.deriveNodeType";
import { readTaxonomy } from "./service.readTaxonomy";
import { type DatasetAdapter } from "./service.types";

/**
 * Bounded scan window over `nodes`, matching `listNodes`' own
 * `MAX_SCANNED_NODES` (service.listNodes.ts): this is a workspace-wide
 * aggregate with no keyset a caller can walk, so it must stay bounded on its
 * own rather than growing unboundedly with the workspace.
 */
const MAX_SCANNED_NODES = 1000;

/** Bounded scan window over `node_revision_terms` for one vocabulary. Every
 *  accepted head can carry several rows in a `many`-cardinality vocabulary
 *  (e.g. `concepts`), so this is sized well above `MAX_SCANNED_NODES`. */
const MAX_SCANNED_TERM_ROWS = 5000;

export type TermUsageRow = { term_id: string; name: string; count: string };
export type TermUsageResult = { rows: TermUsageRow[]; total_unique: string; coverage: "full" | "partial" };

/**
 * K6 (docs/overnight/V3-PARITY.md §5): how many CURRENT heads reference each
 * term of one vocabulary, counted over `node_revision_terms` -- the derived
 * association projection `reconcileRevisionAssociations` writes, NOT the
 * `term_snapshot_json` `listNodes`' `type_term` filter reads. That
 * difference is deliberate here: this method's whole point IS the derived
 * per-term join (a `many`-cardinality vocabulary like `concepts` can never
 * be answered from a single-value snapshot filter), so a head whose revision
 * has not been reconciled yet simply contributes zero rows -- an honest
 * "not yet reconciled", not a fabricated count.
 *
 * Both scan windows are disclosed via `coverage`, the same honesty rule
 * `listNodes`' `type_term`-filtered `total` and the #10/R14 ngram fallback
 * already use: a bounded scan that hits its cap says so instead of silently
 * presenting a partial count as exact.
 */
export async function listTermUsage(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<TermUsageResult> {
  return readTaxonomy(async () => {
    const request = parseListTermUsage(requestBytes);
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
    const window = scanned.slice(0, MAX_SCANNED_NODES);

    const headIds: string[] = [];
    for (const node of window) {
      const headId = node.current_revision_id;
      // Every node this kernel creates is written WITH its first revision's
      // id already in `current_revision_id` (`service.publishRevision.ts`):
      // a null head here is corruption to report, not an emptier row to
      // silently skip -- the same rule `listNodes` follows for the same field.
      if (typeof headId !== "string") failTaxonomy("integrity_failure");
      headIds.push(headId);
    }

    let eligibleHeadIds = headIds;
    if (request.type_term !== null) {
      await reader.refresh(NODE_REVISIONS);
      const kept: string[] = [];
      for (const headId of headIds) {
        const rows = await reader.query(NODE_REVISIONS, `${scope} AND id = ${quote(headId)}`, 2);
        if (rows.length !== 1) failTaxonomy("integrity_failure");
        if (deriveNodeType(rows[0]!) === request.type_term) kept.push(headId);
      }
      eligibleHeadIds = kept;
    }
    const headSet = new Set(eligibleHeadIds);

    await reader.refresh(TERMS_TABLE);
    const termRows = await reader.query(
      TERMS_TABLE,
      `${scope} AND vocabulary_id = ${quote(request.vocabulary_id)}`,
      MAX_SCANNED_TERM_ROWS + 1,
    );
    const rowsTruncated = termRows.length > MAX_SCANNED_TERM_ROWS;
    const rowWindow = termRows.slice(0, MAX_SCANNED_TERM_ROWS);

    const counts = new Map<string, { name: string; count: bigint }>();
    for (const row of rowWindow) {
      const revisionId = row.revision_id;
      const termId = row.term_id;
      const termName = row.term_name_snapshot;
      if (typeof revisionId !== "string" || typeof termId !== "string" || typeof termName !== "string") {
        failTaxonomy("integrity_failure");
      }
      if (!headSet.has(revisionId)) continue;
      const existing = counts.get(termId);
      if (existing === undefined) counts.set(termId, { name: termName, count: 1n });
      else existing.count += 1n;
    }

    const ranked = [...counts.entries()]
      .map(([term_id, v]) => ({ term_id, name: v.name, count: v.count }))
      .sort((a, b) => (b.count === a.count ? a.name.localeCompare(b.name) : Number(b.count - a.count)));

    return {
      rows: ranked.slice(0, request.limit).map((r) => ({ term_id: r.term_id, name: r.name, count: r.count.toString(10) })),
      total_unique: BigInt(counts.size).toString(10),
      coverage: nodesTruncated || rowsTruncated ? "partial" : "full",
    };
  });
}
