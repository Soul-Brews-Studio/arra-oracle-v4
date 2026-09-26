import { failPublication } from "./errors";
import { quote } from "./storage";
import { encodeTraceRow, parseListTraces, timestampToMillis } from "./trace";
import { TRACES } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { countTraceDerivations } from "./service.countTraceDerivations";
import { requireWorkspace } from "./service.requireWorkspace";
import { scanTraceWindow, type TraceCandidate } from "./service.scanTraceWindow";
import { type DatasetAdapter } from "./service.types";

type ListedTrace = Record<string, unknown> & { derived_from_count: number };

/**
 * The full rows for one page, in page order, with `derived_from_count`: ONE
 * `id IN (...)` read for the page, not one read per row.
 */
async function rowsFor(reader: DatasetAdapter, workspace: string, page: TraceCandidate[]): Promise<ListedTrace[]> {
  if (page.length === 0) return [];
  const ids = page.map((c) => c.id);
  const stored = await reader.query(
    TRACES,
    `${contextScope(workspace)} AND id IN (${ids.map(quote).join(", ")})`,
    ids.length + 1,
  );
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of stored) {
    if (typeof row.id !== "string" || byId.has(row.id)) failPublication("integrity_failure", "");
    byId.set(row.id, row);
  }
  const counts = await countTraceDerivations(reader, workspace, ids);
  return ids.map((id) => {
    const row = byId.get(id);
    // The id came from a window just read out of the same table under the
    // same scope; its disappearance between that read and this one is
    // corruption, never a legitimate "not found" for a listing.
    if (row === undefined) return failPublication("integrity_failure", "");
    return { ...encodeTraceRow(row), derived_from_count: counts.get(id)! };
  });
}

export type ListTracesResult = {
  rows: ListedTrace[];
  next_after_created_at: string | null;
  next_after_id: string | null;
  has_more: boolean;
  /** "partial" when the widened scan window could not prove every stored
   *  trace was examined (R14 precedent: an honest disclosure, never a
   *  truncated page presented as if it were exhaustive). */
  coverage: "full" | "partial";
};

/**
 * K5 (docs/overnight/V3-PARITY.md §5): list traces, newest first, in the
 * COMPOUND order `(created_at desc, id asc)` -- two traces can share a
 * millisecond, and `id` alone breaks that tie.
 *
 * `parent_id`, `prev_id`, `depth` and the cursor are pushed into the SQL
 * predicate; the cursor as `created_at < X OR (created_at = X AND id > Y)`,
 * the same shape `listNodes`' `idScope` uses for `after_id` -- without it
 * every page would re-scan the same newest rows regardless of how far the
 * caller had already paged. `query_contains` (a plain substring, not SQL
 * `LIKE`) is finished in JS over a widened window, the same "widen then
 * filter in memory" tradeoff `listNodes` makes for its `type_term` filter.
 * `scanTraceWindow` cuts that window at a tie boundary, so it never ends
 * part-way through a millisecond (fix round 2: a tie straddling the window's
 * tail used to strand its unseen rows behind the cursor).
 *
 * The cursor returned to the caller is the LAST CANDIDATE EXAMINED walking
 * the window (stopping at the row that filled the page), never merely the
 * last MATCH: exactly `listNodes`' `lastExaminedId`. A cursor derived only
 * from matches would resume from the middle of an already-fetched window
 * (skipping everything between the page and the window's tail), and a
 * filter sparse enough to match nothing in a whole window would come back
 * with a null cursor while `has_more` stays true -- a dead end.
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
  // Canonical int64 decimal text by the grammar, so it is a literal, never
  // caller-shaped SQL.
  if (request.depth !== null) filters.push(`depth = ${request.depth}`);
  if (afterCreatedAt !== null && afterId !== null) {
    filters.push(`(created_at < ${afterCreatedAt.toString(10)} OR (created_at = ${afterCreatedAt.toString(10)} AND id > ${quote(afterId)}))`);
  }
  const { candidates, full } = await scanTraceWindow(reader, filters.join(" AND "));

  // Defense in depth, not the only guard: the SQL predicate above already
  // restricts the window to rows past the cursor. Kept so a future predicate
  // edit that silently loses the cursor clause fails here rather than as a
  // silent duplicate page at the wire.
  const pastCursor = (c: TraceCandidate): boolean => {
    if (afterCreatedAt === null) return true;
    if (c.created_at !== afterCreatedAt) return c.created_at < afterCreatedAt;
    return afterId !== null && c.id > afterId;
  };
  const containsQuery = (c: TraceCandidate): boolean =>
    request.query_contains === null || c.query.includes(request.query_contains);

  // Walk the sorted window IN ORDER, `listNodes`' shape: `lastExamined`
  // advances on every candidate looked at (match or not), and the walk stops
  // the instant the page fills -- so a stop mid-window resumes right after
  // the row that filled the page, and running off the end of the window
  // resumes past everything it kept, even if none of it matched.
  const page: TraceCandidate[] = [];
  let lastExamined: TraceCandidate | null = null;
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
  // A full window may have left rows unexamined past what it kept (older
  // rows, or the tail millisecond it cut): an honest "not proven
  // exhaustive", never a page presented as complete.
  const hasMore = stoppedEarly || full;

  return {
    rows: await rowsFor(reader, request.workspace_name, page),
    next_after_created_at:
      hasMore && lastExamined !== null ? new Date(Number(lastExamined.created_at)).toISOString() : null,
    next_after_id: hasMore && lastExamined !== null ? lastExamined.id : null,
    has_more: hasMore,
    coverage: full ? "partial" : "full",
  };
}
