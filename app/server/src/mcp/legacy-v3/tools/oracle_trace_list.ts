import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";

/** `offset` is emulated by walking pages, the same bound `oracle_list`'s own
 *  degraded mode uses (V3-PARITY.md §4.4). */
const MAX_WALK_PAGES = 10;
const PAGE_SIZE = 100;
/** v3's own clamp on `offset` (`src/trace/list.ts:13`). */
const MAX_OFFSET = 10_000;

/** Every argument v3's `oracle_trace_list` schema has (`src/tools/trace.ts:
 *  55-66`). Anything else is named `argument_ignored`, never dropped. */
const V3_ARGS = new Set(["query", "project", "status", "depth", "limit", "offset"]);

type Row = Record<string, unknown> & { derived_from_count: number };
type Warning = { code: string; field: string; detail: string };

/** v3's `boundedInteger` (`src/trace/list.ts:5-9`): truncate, then clamp. */
const bounded = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;

/** `h_metadata` as `oracle_trace` writes it, or `{}` for a trace written
 *  some other way (a native v4 trace may carry anything, or nothing). */
function recorded(row: Row): Record<string, unknown> {
  if (typeof row.h_metadata !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(row.h_metadata);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** v3 filtered `eq(trace_log.depth, depth)` on an integer column; v4's
 *  `depth` is int64 too, so only a non-negative integer can ever match.
 *  Anything else is refused rather than turned into a filter v3 never ran. */
function depthFilter(value: unknown, tool: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /depth: depth must be a non-negative integer", "a trace's depth is a non-negative integer", { path: "/depth" });
  }
  return String(value);
}

/** v3 filtered `eq(trace_log.project, project)` when `project` was truthy.
 *  v4 keeps the same string in the trace's `h_metadata.project`, written
 *  verbatim by `oracle_trace`. */
function projectFilter(value: unknown, tool: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /project: project must be a string", "project names the project a trace was recorded under", { path: "/project" });
  }
  return value;
}

/**
 * `oracle_trace_list` (11 real calls; V3-PARITY.md §4.4, slice V7; v3
 * `src/tools/trace.ts:192-209`, `src/trace/list.ts`). K5's `listTraces`,
 * newest first. `status` has no physical column in either version's storage
 * model; v4 derives it from `derived_from_count` (K5), so `reviewed`/
 * `distilling` -- v3's mutable in-between states -- do not exist here: an
 * immutable trace is either undistilled or has at least one distillation.
 *
 * Fix round 2: v3's `project` and `depth` filters were dropped silently.
 * `depth` is pushed into K5's SQL predicate (the `traces.depth` column);
 * `project` is matched here against `h_metadata.project`, the one place v4
 * keeps it -- the kernel treats `h_metadata` as opaque. Both apply before
 * `offset`, as in v3. A walk that spends its whole page budget without
 * exhausting the filter now says `truncated` instead of a silent short page.
 */
export async function oracle_trace_list(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const status = args.status;
  if (status === "reviewed" || status === "distilling") {
    throw new CompatError(
      context.tool,
      "semantic_refusal",
      `status "${String(status)}" does not exist in v4: a trace is immutable and has no in-between review state`,
      "v4's only distillation states are raw (no derived_from dependent) and distilled (at least one)",
      { path: "/status" },
    );
  }
  if (status !== undefined && status !== null && status !== "raw" && status !== "distilled") {
    throw new CompatError(context.tool, "unsupported_argument", `Invalid input at /status: unknown status "${String(status)}"`, "status must be raw or distilled", { path: "/status" });
  }
  const depth = depthFilter(args.depth, context.tool);
  const project = projectFilter(args.project, context.tool);

  const warnings: Warning[] = [];
  for (const key of Object.keys(args).sort()) {
    if (!V3_ARGS.has(key)) warnings.push({ code: "argument_ignored", field: key, detail: "not an oracle_trace_list argument in v3 or v4" });
  }

  const limit = bounded(args.limit, 20, 1, 100);
  const query_contains = typeof args.query === "string" && args.query.trim() !== "" ? args.query : null;
  let toSkip = bounded(args.offset, 0, 0, MAX_OFFSET);

  const matched: Row[] = [];
  let after_created_at: string | null = null;
  let after_id: string | null = null;
  let exhausted = false;
  for (let page = 0; page < MAX_WALK_PAGES && matched.length < limit; page++) {
    const result = (await context.kb("listTraces", {
      parent_id: null,
      prev_id: null,
      depth,
      query_contains,
      after_created_at,
      after_id,
      limit: PAGE_SIZE,
    })) as { rows: Row[]; next_after_created_at: string | null; next_after_id: string | null; has_more: boolean };

    for (const row of result.rows) {
      const distilled = row.derived_from_count > 0;
      if (status === "raw" && distilled) continue;
      if (status === "distilled" && !distilled) continue;
      if (project !== null && recorded(row).project !== project) continue;
      if (toSkip > 0) {
        toSkip -= 1;
        continue;
      }
      matched.push(row);
      if (matched.length >= limit) break;
    }
    if (!result.has_more) {
      exhausted = true;
      break;
    }
    // K5 (`listTraces`) promises a non-null cursor whenever `has_more` is
    // true (docs/overnight/V3-PARITY.md §5). Copying a null cursor into the
    // next request would restart the walk from the newest trace: rows
    // already matched come back a second time, and later matches past this
    // page are never reached. Stop honestly instead -- an under-reported
    // "might be more" is never silently truncated OR duplicated.
    if (result.next_after_created_at === null || result.next_after_id === null) break;
    after_created_at = result.next_after_created_at;
    after_id = result.next_after_id;
  }

  // Exhausted the whole predicate within the walk AND filled fewer than
  // `limit`: definitely no more. Anything else (filled the page, or the
  // walk itself was capped) is an honest "might be more" -- never a short
  // page presented as if it were the end.
  const has_more = !(exhausted && matched.length < limit);
  if (!exhausted && matched.length < limit) {
    warnings.push({
      code: "truncated",
      field: "traces",
      detail: `stopped after examining ${MAX_WALK_PAGES * PAGE_SIZE} traces without exhausting the filters and offset; has_more is true`,
    });
  }

  return {
    traces: matched.map((row) => {
      const scope = recorded(row).scope;
      return {
        trace_id: row.id,
        query: row.query,
        // v3's own default for a trace with no recorded scope (`list.ts:47`).
        scope: typeof scope === "string" && scope !== "" ? scope : "project",
        depth: Number(row.depth as string),
        // Not carried in the list view without a per-row body read (hits);
        // available on oracle_trace_get. Named below, never silent.
        file_count: null,
        commit_count: null,
        issue_count: null,
        status: row.derived_from_count > 0 ? "distilled" : "raw",
        has_awakening: row.derived_from_count > 0,
        created_at: row.created_at,
      };
    }),
    total: null,
    has_more,
    compat_warnings: [
      { code: "field_unavailable", field: "file_count", detail: "listing does not read each trace's body; use oracle_trace_get" },
      { code: "field_unavailable", field: "commit_count", detail: "listing does not read each trace's body; use oracle_trace_get" },
      { code: "field_unavailable", field: "issue_count", detail: "listing does not read each trace's body; use oracle_trace_get" },
      { code: "partial", field: "total", detail: "an exact total needs a full scan; not computed" },
      ...warnings,
    ],
  };
}
