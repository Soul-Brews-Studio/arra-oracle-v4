import { requestBytes } from "./db.legacyRead.requestBytes";
import { openTarget19MemoryReader } from "./db.legacyRead.openTarget19MemoryReader";
import { mapAcceptedHeadToMemory, type LegacyMemoryRow } from "./db.legacyRead.mapAcceptedHeadToMemory";
import { type MemoryFilters } from "./db.list";

// `listNodes`' own page ceiling (`service.parseListNodes.ts`'s
// `MAX_PAGE_LIMIT`); pages are walked by `after_id` until either every node
// in the workspace has been seen or `limit` legacy-filtered matches are
// found. A `type_term` id-based filter at the `listNodes` layer, matching
// `filters.type` by NAME through the vocabulary, is future work for S3 (this
// stays read-only, additive, S2-scoped).
const PAGE_LIMIT = 100;

/**
 * Target-19-backed `db.list`: `listNodes` (id-order, include_inactive) supplies
 * every node id in the workspace; each is resolved to its full head revision
 * through `getAcceptedHead` (the same kernel `db.legacyRead.getById` uses) and
 * mapped to the legacy row shape, then every legacy filter -- `type`,
 * `session_name`, `peer_name`, `subject_peer_name`, `sync_state`, `is_active`
 * -- is applied in that shape, exactly like `db.list.ts`'s own predicates,
 * BEFORE `limit` truncates the result.
 */
export async function list(bank: string, limit = 50, filters: MemoryFilters = {}): Promise<LegacyMemoryRow[]> {
  const bundle = await openTarget19MemoryReader();
  const out: LegacyMemoryRow[] = [];
  let afterId: string | null = null;
  for (;;) {
    const listing = (await bundle.publication.listNodes(
      requestBytes({
        workspace_name: bank,
        after_id: afterId,
        limit: PAGE_LIMIT,
        include_total: false,
        type_term: null,
        include_inactive: true,
      }),
    )) as { rows: Array<{ id: string }>; next_after_id: string | null };

    for (const nodeRow of listing.rows) {
      const found = (await bundle.publication.getAcceptedHead(
        requestBytes({ workspace_name: bank, node_id: nodeRow.id }),
      )) as { node: Record<string, unknown>; revision: Record<string, unknown>; lifecycle: { kind: string; new_id: string | null } | null } | null;
      if (found === null) continue;
      const memory = mapAcceptedHeadToMemory(found);
      if (filters.type !== undefined && memory.type !== filters.type) continue;
      if (filters.session_name !== undefined && memory.session_name !== filters.session_name) continue;
      if (filters.peer_name !== undefined && memory.peer_name !== filters.peer_name) continue;
      if (filters.subject_peer_name !== undefined && memory.subject_peer_name !== filters.subject_peer_name) continue;
      if (filters.sync_state !== undefined && memory.sync_state !== filters.sync_state) continue;
      if (filters.is_active !== undefined && memory.is_active !== filters.is_active) continue;
      out.push(memory);
      if (out.length >= limit) return out;
    }
    if (listing.next_after_id === null) return out;
    afterId = listing.next_after_id;
  }
}
