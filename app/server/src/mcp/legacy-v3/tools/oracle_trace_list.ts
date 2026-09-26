import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";

/** `offset` is emulated by walking pages, the same bound `oracle_list`'s own
 *  degraded mode uses (V3-PARITY.md §4.4). */
const MAX_WALK_PAGES = 10;
const PAGE_SIZE = 100;

type Row = Record<string, unknown> & { derived_from_count: number };

/**
 * `oracle_trace_list` (11 real calls; V3-PARITY.md §4.4, slice V7; v3
 * `src/tools/trace.ts:192-209`). K5's `listTraces`, newest first. `status`
 * has no physical column in either version's storage model; v4 derives it
 * from `derived_from_count` (K5), so `reviewed`/`distilling` -- v3's
 * mutable in-between states -- do not exist here: an immutable trace is
 * either undistilled or has at least one distillation, nothing between.
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

  const limit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20;
  const query_contains = typeof args.query === "string" && args.query.trim() !== "" ? args.query : null;
  let toSkip = typeof args.offset === "number" && Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;

  const matched: Row[] = [];
  let after_created_at: string | null = null;
  let after_id: string | null = null;
  let exhausted = false;
  for (let page = 0; page < MAX_WALK_PAGES && matched.length < limit; page++) {
    const result = (await context.kb("listTraces", {
      parent_id: null,
      prev_id: null,
      query_contains,
      after_created_at,
      after_id,
      limit: PAGE_SIZE,
    })) as { rows: Row[]; next_after_created_at: string | null; next_after_id: string | null; has_more: boolean };

    for (const row of result.rows) {
      const distilled = row.derived_from_count > 0;
      if (status === "raw" && distilled) continue;
      if (status === "distilled" && !distilled) continue;
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
    after_created_at = result.next_after_created_at;
    after_id = result.next_after_id;
  }

  // Exhausted the whole predicate within the walk AND filled fewer than
  // `limit`: definitely no more. Anything else (filled the page, or the
  // walk itself was capped) is an honest "might be more" -- never a short
  // page presented as if it were the end.
  const has_more = !(exhausted && matched.length < limit);

  return {
    traces: matched.map((row) => ({
      trace_id: row.id,
      query: row.query,
      scope: null,
      depth: Number(row.depth as string),
      // Not carried in the list view without a per-row body read (h_metadata
      // + hits); available on oracle_trace_get. Named below, never silent.
      file_count: null,
      commit_count: null,
      issue_count: null,
      status: row.derived_from_count > 0 ? "distilled" : "raw",
      has_awakening: row.derived_from_count > 0,
      created_at: row.created_at,
    })),
    total: null,
    has_more,
    compat_warnings: [
      { code: "field_unavailable", field: "file_count", detail: "listing does not read each trace's body; use oracle_trace_get" },
      { code: "field_unavailable", field: "commit_count", detail: "listing does not read each trace's body; use oracle_trace_get" },
      { code: "field_unavailable", field: "issue_count", detail: "listing does not read each trace's body; use oracle_trace_get" },
      { code: "partial", field: "total", detail: "an exact total needs a full scan; not computed" },
    ],
  };
}
