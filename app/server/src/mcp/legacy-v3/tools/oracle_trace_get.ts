import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { resolveTraceId } from "../ids.resolveTraceId";
import { readTraceHits } from "../trace-hits";

type TraceRow = Record<string, unknown>;
type Kb = V3ToolContext["kb"];

/** `listTraceHits` caps one page at 200; `createTrace` allows up to 256
 *  hits, so up to two pages can hold everything a real trace ever wrote. */
async function allHits(kb: Kb, traceId: string): Promise<Record<string, unknown>[]> {
  const hits: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (let page = 0; page < 2; page++) {
    const result = (await kb("listTraceHits", { trace_id: traceId, after_position: after, limit: 200 })) as {
      rows: Record<string, unknown>[];
      next_after_position: string | null;
    };
    hits.push(...result.rows);
    if (result.next_after_position === null) break;
    after = result.next_after_position;
  }
  return hits;
}

/** "distilled" nodes: current heads that `derived_from`-link this trace
 *  (`scanDependents`, the live O(nodes×rows) walk -- correct even the instant
 *  after a distill, unlike K5's `revision_links` projection which needs
 *  `reconcileRevisionAssociations` to run first). */
async function distilledNodeIds(kb: Kb, traceId: string): Promise<string[]> {
  const scan = (await kb("scanDependents", {
    target_kind: "trace",
    target: { trace_id: traceId },
    revision_mode: "current",
    limit: 100,
    cursor: null,
  })) as { occurrences?: { node_id: string; is_snapshot_head: boolean; link: { relation: string } }[] };
  const ids = new Set<string>();
  for (const occurrence of scan.occurrences ?? []) {
    if (occurrence.is_snapshot_head && occurrence.link?.relation === "derived_from") ids.add(occurrence.node_id);
  }
  return [...ids];
}

/** A reduced v3 `TraceSummary` for the `includeChain` walk (V7, K5): status
 *  needs a `scanDependents` call per row, so this is deliberately not run
 *  over every trace in a bank -- only over the bounded parent/child set
 *  below. */
async function summaryOf(kb: Kb, row: TraceRow): Promise<{ trace_id: string; query: string; depth: number; status: "raw" | "distilled"; created_at: string }> {
  const id = row.id as string;
  const distilled = await distilledNodeIds(kb, id);
  return {
    trace_id: id,
    query: row.query as string,
    depth: Number(row.depth as string),
    status: distilled.length > 0 ? "distilled" : "raw",
    created_at: row.created_at as string,
  };
}

const MAX_CHAIN_STEPS = 1024;
const MAX_CHILDREN = 100;

/**
 * `oracle_trace_get` (12 real calls; V3-PARITY.md §4.2; v3 `src/tools/
 * trace.ts:68-79,240-278`). `getTrace` + `listTraceHits` (`../trace-hits.ts`
 * reverses `oracle_trace`'s split) + `scanDependents` for distillation +
 * (V7) `listTraces` for `child_trace_ids`/`next_trace_id`, which K5 makes
 * available in the SAME slice this file ships in.
 */
export async function oracle_trace_get(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const trace = await resolveTraceId(context.kb, args.traceId, context.tool);
  if (trace === null) {
    throw new CompatError(context.tool, "no_results", `Trace ${String(args.traceId)} not found`, "no trace with this id exists in this bank", { path: "/traceId" });
  }
  const id = trace.id as string;

  const hits = await allHits(context.kb, id);
  const meta = typeof trace.h_metadata === "string" ? (JSON.parse(trace.h_metadata) as Record<string, unknown>) : {};
  const found = readTraceHits((meta.legacy as Record<string, unknown> | undefined) ?? null, hits);

  const distilled = await distilledNodeIds(context.kb, id);

  const childrenPage = (await context.kb("listTraces", {
    parent_id: id,
    prev_id: null,
    depth: null,
    query_contains: null,
    after_created_at: null,
    after_id: null,
    limit: MAX_CHILDREN,
  })) as { rows: TraceRow[]; has_more: boolean };
  const childTraceIds = childrenPage.rows.map((row) => row.id as string);

  const nextPage = (await context.kb("listTraces", {
    parent_id: null,
    prev_id: id,
    depth: null,
    query_contains: null,
    after_created_at: null,
    after_id: null,
    limit: 2,
  })) as { rows: TraceRow[] };
  const nextTraceId = nextPage.rows.length === 1 ? (nextPage.rows[0]!.id as string) : null;

  const compat_warnings: { code: string; field: string; detail: string }[] = [];
  if (childrenPage.has_more) {
    compat_warnings.push({ code: "truncated", field: "child_trace_ids", detail: `more than ${MAX_CHILDREN} child traces exist` });
  }
  if (nextPage.rows.length > 1) {
    compat_warnings.push({ code: "semantic_change", field: "next_trace_id", detail: "several traces point prevTraceId here (a fork); v4 allows this, v3 did not, so next_trace_id is left null" });
  }

  let chain: { traces: unknown[]; total_depth: number; has_awakening: boolean; awakening_trace_id: string | null } | undefined;
  if (args.includeChain === true) {
    const ancestors: TraceRow[] = [];
    let cursor: TraceRow = trace;
    for (let steps = 0; cursor.parent_id !== null && steps < MAX_CHAIN_STEPS; steps++) {
      const parent = (await context.kb("getTrace", { id: cursor.parent_id })) as TraceRow | null;
      if (parent === null) break;
      ancestors.unshift(parent);
      cursor = parent;
    }
    // Sequential, deliberately: these all share the ONE bundle this tool
    // call opened (`createKb`'s `pinned` bundle), and its adapter's
    // per-table handle cache is not meant for concurrent callers
    // (`service.makeAdapter.ts`) -- the same reason `service.listTraces.ts`
    // reads its own page one row at a time.
    const children: TraceRow[] = [];
    for (const childId of childTraceIds) {
      const child = (await context.kb("getTrace", { id: childId })) as TraceRow | null;
      if (child !== null) children.push(child);
    }
    const rows = [...ancestors, trace, ...children];
    const summaries: Awaited<ReturnType<typeof summaryOf>>[] = [];
    for (const row of rows) summaries.push(await summaryOf(context.kb, row));
    const awakened = summaries.find((s) => s.status === "distilled");
    chain = {
      traces: summaries,
      total_depth: summaries.reduce((max, s) => Math.max(max, s.depth), 0),
      has_awakening: awakened !== undefined,
      awakening_trace_id: awakened?.trace_id ?? null,
    };
  }

  let awakening: string | null = null;
  if (distilled.length > 0) {
    const head = (await context.kb("getAcceptedHead", { node_id: distilled[0] })) as { revision?: { body?: string } } | null;
    awakening = head?.revision?.body ?? null;
  }

  return {
    trace_id: id,
    query: trace.query,
    query_type: meta.query_type ?? null,
    scope: meta.scope ?? null,
    depth: Number(trace.depth as string),
    status: distilled.length > 0 ? "distilled" : "raw",
    found_files: found.found_files,
    found_commits: found.found_commits,
    found_issues: found.found_issues,
    found_retrospectives: found.found_retrospectives,
    found_learnings: found.found_learnings,
    found_resonance: found.found_resonance,
    file_count: found.found_files.length + found.found_retrospectives.length + found.found_learnings.length + found.found_resonance.length,
    commit_count: found.found_commits.length,
    issue_count: found.found_issues.length,
    parent_trace_id: trace.parent_id,
    child_trace_ids: childTraceIds,
    prev_trace_id: trace.prev_id,
    next_trace_id: nextTraceId,
    project: meta.project ?? null,
    agent_count: meta.agent_count ?? null,
    duration_ms: meta.duration_ms ?? null,
    awakening,
    distilled_to_id: distilled[0] ?? null,
    distilled_to_ids: distilled,
    distilled_count: distilled.length,
    created_at: trace.created_at,
    updated_at: trace.updated_at,
    ...(chain === undefined ? {} : { chain }),
    ...(compat_warnings.length > 0 ? { compat_warnings } : {}),
  };
}
