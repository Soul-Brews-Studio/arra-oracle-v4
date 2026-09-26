import type { V3ToolContext } from "../handlers";
import { resolveTraceId } from "../ids.resolveTraceId";

type TraceRow = Record<string, unknown>;
const MAX_STEPS = 1024;

/**
 * `oracle_trace_chain` (0 real calls; V3-PARITY.md §4.3; v3 `src/trace/
 * chain.ts`'s `getTraceLinkedChain`, walked over `prev`/`next`, NOT the
 * parent/child tree `oracle_trace_get`'s `includeChain` walks). Backward is
 * always available (`prev_id`, stored on every trace); forward needs K5
 * (`listTraces({prev_id})`), which ships in the SAME slice as this file.
 *
 * v3's `nextTraceId` is a single maintained pointer (`oracle_trace_link` kept
 * it exclusive); v4 allows several traces to name the same `prev_id` (a
 * fork, D11: linking is not carried, so nothing PREVENTS one). Reaching a
 * fork stops the forward walk and reports it rather than picking a branch.
 */
export async function oracle_trace_chain(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const start = await resolveTraceId(context.kb, args.traceId, context.tool);
  // An unknown (but well-formed) start is v3's own answer: an empty chain,
  // never an error (`getTraceLinkedChain` returns this when `getTrace` finds
  // nothing to walk from).
  if (start === null) return { chain: [], position: 0, chain_length: 0 };

  // Backward: walk `prev_id` to the earliest reachable ancestor.
  let head = start;
  const seenBack = new Set<string>([head.id as string]);
  for (let steps = 0; head.prev_id !== null && steps < MAX_STEPS; steps++) {
    const prev = (await context.kb("getTrace", { id: head.prev_id })) as TraceRow | null;
    if (prev === null || seenBack.has(prev.id as string)) break;
    seenBack.add(prev.id as string);
    head = prev;
  }

  // Forward: one successor at a time. `limit:2` is the cheapest way to tell
  // "exactly one" from "a fork" without reading a third row.
  const rows: TraceRow[] = [head];
  const seenForward = new Set<string>([head.id as string]);
  let forked = false;
  let branches: string[] = [];
  let cursor = head;
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    const successors = (await context.kb("listTraces", {
      parent_id: null,
      prev_id: cursor.id,
      query_contains: null,
      after_created_at: null,
      after_id: null,
      limit: 2,
    })) as { rows: TraceRow[] };
    if (successors.rows.length === 0) break;
    if (successors.rows.length > 1) {
      forked = true;
      branches = successors.rows.map((row) => row.id as string);
      break;
    }
    const next = successors.rows[0]!;
    // A cycle here would be stored corruption (createTrace's own
    // assertTraceChain refuses one on write); this is a defensive stop, not
    // an expected path.
    if (seenForward.has(next.id as string)) break;
    seenForward.add(next.id as string);
    rows.push(next);
    cursor = next;
  }

  const chain = rows.map((row, index) => ({
    trace_id: row.id,
    query: row.query,
    prev_trace_id: row.prev_id,
    next_trace_id: index + 1 < rows.length ? rows[index + 1]!.id : null,
    created_at: row.created_at,
  }));
  const position = rows.findIndex((row) => row.id === start.id);

  return {
    chain,
    position: position < 0 ? 0 : position,
    chain_length: chain.length,
    ...(forked ? { forked: true, branches } : {}),
  };
}
