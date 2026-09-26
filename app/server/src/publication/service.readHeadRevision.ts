import { failTaxonomy } from "./taxonomy.failTaxonomy";
import { NODE_REVISIONS } from "./service.constants";
import { type DatasetAdapter } from "./service.types";
import { quote } from "./storage";

/**
 * The ONE accepted head revision a node's `current_revision_id` names,
 * projected to `id` + `term_snapshot_json` only: the K6/K7 aggregates
 * (`listTermUsage`, `knowledgeStats.by_type`) read nothing else, and a full
 * row would drag every head's body through this process for nothing.
 *
 * Same rule `listNodes` applies to the same field: a null head, a pointer to
 * no row, or two rows at one revision identity is stored corruption to
 * report, never a softer "skip this node" that would quietly shrink a count
 * the caller then reads as exact. The caller refreshes `node_revisions` once
 * before its loop.
 */
export async function readHeadRevision(reader: DatasetAdapter, scope: string, headId: unknown): Promise<Record<string, unknown>> {
  if (typeof headId !== "string") failTaxonomy("integrity_failure");
  const rows = await reader.orderedProjection(
    NODE_REVISIONS,
    `${scope} AND id = ${quote(headId)}`,
    ["id", "term_snapshot_json"],
    { column: "id", ascending: true },
    2,
  );
  if (rows.length !== 1) failTaxonomy("integrity_failure");
  return rows[0]!;
}
