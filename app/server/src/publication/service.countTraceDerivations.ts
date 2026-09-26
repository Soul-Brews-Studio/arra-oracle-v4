import { targetOp } from "../contracts/evidence-v1";
import { obj } from "../contracts/jcs";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { LINKS_TABLE, NODES } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/** Values per `IN (...)` list, so one predicate never grows with the data. */
const IN_CHUNK = 200;

const chunks = <T>(values: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
};

const inList = (values: string[]): string => values.map(quote).join(", ");

/**
 * `derived_from_count` for one page of traces, keyed by trace id:
 * `revision_links` (target_kind="trace", relation="derived_from") JOINED to
 * each linking revision's own node, keeping only rows where that revision is
 * still the node's CURRENT head (V3-PARITY.md §5 K5) -- a superseded distill
 * does not count, and this is O(matches), never `scanDependents`'
 * O(nodes×rows) live walk. `revision_links` is a RECONCILED projection
 * (`reconcileRevisionAssociations`), not written by `publishRevision`
 * itself; a caller that wants a fresh count must reconcile the writing
 * revision first (the V3 adapter's `oracle_trace_distill` does this).
 *
 * One `IN (...)` read per table for the whole page, not one read per trace:
 * a per-row read made every page cost `limit` x three round trips, which is
 * what put a 21-page walk over bun's 5 s default under machine load.
 */
export async function countTraceDerivations(
  reader: DatasetAdapter,
  workspace: string,
  traceIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(traceIds.map((id) => [id, 0]));
  if (traceIds.length === 0) return counts;
  const scope = contextScope(workspace);

  const traceOfKey = new Map<string, string>();
  for (const id of traceIds) traceOfKey.set(targetOp(workspace, "trace", obj({ trace_id: id }), []).target_key, id);

  await reader.refresh(LINKS_TABLE);
  const links: { traceId: string; revisionId: string }[] = [];
  for (const keys of chunks([...traceOfKey.keys()])) {
    const rows = await reader.query(
      LINKS_TABLE,
      `${scope} AND target_kind = 'trace' AND relation = 'derived_from' AND target_key IN (${inList(keys)})`,
    );
    for (const row of rows) {
      const traceId = typeof row.target_key === "string" ? traceOfKey.get(row.target_key) : undefined;
      // A row outside the keys just asked for is the predicate lying.
      if (traceId === undefined || typeof row.revision_id !== "string") failPublication("integrity_failure", "");
      links.push({ traceId, revisionId: row.revision_id });
    }
  }
  if (links.length === 0) return counts;

  await reader.refresh(NODES);
  const current = new Set<string>();
  for (const revisionIds of chunks([...new Set(links.map((l) => l.revisionId))])) {
    const heads = await reader.query(NODES, `${scope} AND current_revision_id IN (${inList(revisionIds)})`, revisionIds.length + 1);
    for (const head of heads) {
      const revisionId = head.current_revision_id;
      if (typeof revisionId !== "string") failPublication("integrity_failure", "");
      // Two nodes whose head pointer names the same revision is corruption,
      // never a legitimate double count.
      if (current.has(revisionId)) failPublication("integrity_failure", "");
      current.add(revisionId);
    }
  }
  for (const link of links) {
    if (current.has(link.revisionId)) counts.set(link.traceId, counts.get(link.traceId)! + 1);
  }
  return counts;
}
