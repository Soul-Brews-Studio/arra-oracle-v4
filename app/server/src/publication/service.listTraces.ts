import { targetOp } from "../contracts/evidence-v1";
import { obj } from "../contracts/jcs";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { encodeTraceRow, parseListTraces, timestampToMillis } from "./trace";
import { LINKS_TABLE, NODES, TRACES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/**
 * Widened scan window for a filtered page (`parent_id`/`prev_id`/
 * `query_contains`), mirroring `listNodes`' `MAX_SCANNED_NODES`: matches can
 * be sparse across the `created_at`-ordered keyset, so the number of MATCHES
 * requested (`limit`) cannot also bound how many stored rows get examined to
 * find them. One call's worth of extra read work, never unbounded.
 */
const MAX_SCANNED_TRACES = 1000;

type Candidate = { id: string; created_at: bigint; query: string };

const millisOf = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return failPublication("integrity_failure", "");
};

/**
 * `revision_links` (target_kind="trace", relation="derived_from") JOINED to
 * each linking revision's own node, keeping only rows where that revision is
 * still the node's CURRENT head (V3-PARITY.md §5 K5) -- a superseded distill
 * does not count, and this is O(matches), never `scanDependents`'
 * O(nodes×rows) live walk. `revision_links` is a RECONCILED projection
 * (`reconcileRevisionAssociations`), not written by `publishRevision`
 * itself; a caller that wants a fresh count must reconcile the writing
 * revision first (the V3 adapter's `oracle_trace_distill` does this).
 */
async function countDerivedFrom(reader: DatasetAdapter, workspace: string, traceId: string): Promise<number> {
  await reader.refresh(LINKS_TABLE);
  const { target_key } = targetOp(workspace, "trace", obj({ trace_id: traceId }), []);
  const links = await reader.query(
    LINKS_TABLE,
    `${contextScope(workspace)} AND target_kind = 'trace' AND target_key = ${quote(target_key)} AND relation = 'derived_from'`,
  );
  if (links.length === 0) return 0;
  await reader.refresh(NODES);
  let count = 0;
  for (const link of links) {
    const revisionId = link.revision_id;
    if (typeof revisionId !== "string") failPublication("integrity_failure", "");
    // 0/1/>1 discrimination on the head pointer itself: a node's
    // `current_revision_id` naming the same revision twice is corruption,
    // never a legitimate double count.
    const heads = await reader.query(NODES, `${contextScope(workspace)} AND current_revision_id = ${quote(revisionId)}`, 2);
    if (heads.length > 1) failPublication("integrity_failure", "");
    if (heads.length === 1) count += 1;
  }
  return count;
}

async function rowFor(
  reader: DatasetAdapter,
  workspace: string,
  id: string,
): Promise<Record<string, unknown> & { derived_from_count: number }> {
  const row = await contextOne(reader, TRACES, `${contextScope(workspace)} AND id = ${quote(id)}`);
  // The id came from a page just read out of the same table under the same
  // scope; its disappearance between that read and this one is corruption,
  // never a legitimate "not found" for a listing.
  if (row === null) failPublication("integrity_failure", "");
  const encoded = encodeTraceRow(row);
  const derived_from_count = await countDerivedFrom(reader, workspace, id);
  return { ...encoded, derived_from_count };
}

export type ListTracesResult = {
  rows: (Record<string, unknown> & { derived_from_count: number })[];
  next_after_created_at: string | null;
  next_after_id: string | null;
  has_more: boolean;
  /** "partial" when the widened scan window could not prove every stored
   *  trace was examined (R14 precedent: an honest disclosure, never a
   *  truncated page presented as if it were exhaustive). */
  coverage: "full" | "partial";
};

/**
 * K5 (docs/overnight/V3-PARITY.md §5): list traces, newest first.
 *
 * `DatasetAdapter.orderedProjection` sorts by exactly ONE column, but the
 * kernel's ordering contract is the COMPOUND `(created_at desc, id asc)` --
 * two traces can share a millisecond, and `id` alone breaks that tie. This
 * fetches a widened window ordered by `created_at desc`, then finishes the
 * compound sort and the `query_contains` substring filter in JS -- the same
 * "widen then filter in memory" tradeoff `listNodes` makes for its
 * `type_term` filter.
 *
 * The cursor, by contrast, IS pushed into the SQL predicate (`created_at <
 * X OR (created_at = X AND id > Y)`), the same shape `listNodes`' `idScope`
 * uses for `after_id` -- without it every page would re-scan the same
 * newest `MAX_SCANNED_TRACES` rows regardless of how far the caller had
 * already paged, which is a dead end past that many stored rows.
 *
 * The cursor returned to the caller is the LAST ROW EXAMINED walking the
 * sorted window (stopping at the row that filled the page, same as every
 * other row before it), never merely the last MATCH: exactly `listNodes`'
 * `lastExaminedId`, which advances on every id looked at, whether or not it
 * passed that kernel's own `type_term` filter. A cursor derived only from
 * matches has two failure shapes here -- resuming from the middle of an
 * ALREADY-FETCHED window (unfiltered case, `MAX_SCANNED_TRACES` bigger than
 * `limit`) would re-derive the wrong "last returned row" and skip everything
 * between the page and the window's tail; and a `query_contains` filter
 * sparse enough that an entire widened window matches nothing would come
 * back with a null cursor while `has_more` stays true -- a dead end.
 */
export async function listTraces(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<ListTracesResult> {
  const request = parseListTraces(requestBytes);
  await requireWorkspace(reader, request.workspace_name);
  await reader.refresh(TRACES);

  const afterCreatedAt = request.after_created_at === null ? null : timestampToMillis(request.after_created_at);
  const afterId = request.after_id;

  const filters = [contextScope(request.workspace_name)];
  if (request.parent_id !== null) filters.push(`parent_id = ${quote(request.parent_id)}`);
  if (request.prev_id !== null) filters.push(`prev_id = ${quote(request.prev_id)}`);
  if (afterCreatedAt !== null && afterId !== null) {
    filters.push(`(created_at < ${afterCreatedAt.toString(10)} OR (created_at = ${afterCreatedAt.toString(10)} AND id > ${quote(afterId)}))`);
  }
  const predicate = filters.join(" AND ");

  const scanned = await reader.orderedProjection(
    TRACES,
    predicate,
    ["id", "created_at", "query"],
    { column: "created_at", ascending: false },
    MAX_SCANNED_TRACES,
  );

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const row of scanned) {
    const id = row.id;
    if (typeof id !== "string") failPublication("integrity_failure", "");
    // A duplicate id in one window would be invisible to the compound sort
    // below; caught here rather than let it silently double- or under-count.
    if (seen.has(id)) failPublication("integrity_failure", "");
    seen.add(id);
    const query = row.query;
    if (typeof query !== "string") failPublication("integrity_failure", "");
    candidates.push({ id, created_at: millisOf(row.created_at), query });
  }
  candidates.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Defense in depth, not the only guard: the SQL predicate above already
  // restricts `scanned` to rows past the cursor, so this should always be
  // true. Kept so a future predicate edit that silently loses the cursor
  // clause fails on an assertion here rather than on a silent duplicate
  // page at the wire.
  const pastCursor = (c: Candidate): boolean => {
    if (afterCreatedAt === null) return true;
    if (c.created_at !== afterCreatedAt) return c.created_at < afterCreatedAt;
    return afterId !== null && c.id > afterId;
  };
  const containsQuery = (c: Candidate): boolean =>
    request.query_contains === null || c.query.includes(request.query_contains);

  // Walk the sorted window IN ORDER, exactly `listNodes`' shape: `lastExamined`
  // advances on every candidate looked at (match or not), and the walk stops
  // the instant the page fills -- so a stop mid-window leaves `lastExamined`
  // at the row that just filled the page (resume right after it, nothing
  // skipped), while running off the end of the window leaves it at the very
  // last candidate examined (resume past the whole window, even if that
  // window held no matches at all).
  const page: Candidate[] = [];
  let lastExamined: Candidate | null = null;
  let stoppedEarly = false;
  for (const c of candidates) {
    lastExamined = c;
    if (!pastCursor(c) || !containsQuery(c)) continue;
    page.push(c);
    if (page.length >= request.limit) {
      stoppedEarly = true;
      break;
    }
  }
  // The window might not have reached every stored trace matching the SQL
  // predicate (there could be more, older than the window's tail), OR the
  // walk stopped early with the window itself unexamined past that point:
  // an honest "not proven exhaustive", never a page presented as if it were
  // complete.
  const windowExhausted = scanned.length < MAX_SCANNED_TRACES;
  const hasMore = stoppedEarly || !windowExhausted;
  const coverage: "full" | "partial" = windowExhausted ? "full" : "partial";

  // Sequential, deliberately: `rowFor` shares this ONE adapter's per-table
  // handle cache and cursor state (`makeAdapter.ts`), the same reason every
  // other multi-row read in this package (`listNodes`, `scanDependents`)
  // loops with `await` instead of `Promise.all`.
  const rows: (Record<string, unknown> & { derived_from_count: number })[] = [];
  for (const c of page) rows.push(await rowFor(reader, request.workspace_name, c.id));

  return {
    rows,
    next_after_created_at:
      hasMore && lastExamined !== null ? new Date(Number(lastExamined.created_at)).toISOString() : null,
    next_after_id: hasMore && lastExamined !== null ? lastExamined.id : null,
    has_more: hasMore,
    coverage,
  };
}
