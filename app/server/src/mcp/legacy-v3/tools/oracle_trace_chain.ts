import type { V3ToolContext } from "../handlers";
import { resolveTraceId } from "../ids.resolveTraceId";

type TraceRow = Record<string, unknown>;
const MAX_STEPS = 1024;
/** Successors read per hop: one page of K5, so a fork names every branch
 *  up to this many (fix round 2; it used to read 2 and name only 2). */
const MAX_BRANCHES = 100;

/**
 * `oracle_trace_chain` (0 real calls; V3-PARITY.md §4.3; v3 `src/trace/
 * chain.ts`'s `getTraceLinkedChain`, walked over `prev`/`next`, NOT the
 * parent/child tree `oracle_trace_get`'s `includeChain` walks). Backward is
 * always available (`prev_id`, stored on every trace); forward needs K5
 * (`listTraces({prev_id})`), which ships in the SAME slice as this file.
 *
 * v3's `nextTraceId` is a single maintained pointer (`oracle_trace_link` kept
 * it exclusive); v4 allows several traces to name the same `prev_id` (a
 * fork, D11: linking is not carried, so nothing PREVENTS one).
 *
 * FIX (overnight R18 fix round): `prev_id` is single-valued -- walking it
 * backward from `start` can never itself hit a fork, only FORWARD listing
 * can (several traces sharing one `prev_id`). So the segment from the
 * earliest reachable ancestor up to `start` is already fully known from that
 * backward walk and is never ambiguous; only what comes AFTER `start` is
 * unknown and needs a `listTraces({prev_id})` round trip. An earlier version
 * of this file threw the backward path away and tried to re-derive it
 * forward from the root instead, so a fork upstream of `start` (an unrelated
 * trace also naming the root as `prev_id`) stopped the walk before it ever
 * reached `start`: `position` fell back to 0 on a chain that no longer
 * contained the trace the caller asked for. Reaching a genuine fork AFTER
 * `start` still stops the forward-continuation walk and reports it, rather
 * than picking a branch.
 */
export async function oracle_trace_chain(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const start = await resolveTraceId(context.kb, args.traceId, context.tool);
  // An unknown (but well-formed) start is v3's own answer: an empty chain,
  // never an error (`getTraceLinkedChain` returns this when `getTrace` finds
  // nothing to walk from).
  if (start === null) return { chain: [], position: 0, chain_length: 0 };

  // Backward: walk `prev_id` to the earliest reachable ancestor, recording
  // every node visited -- `backward` ends up `[start, ..., root]`.
  const backward: TraceRow[] = [start];
  const seenBack = new Set<string>([start.id as string]);
  for (let steps = 0; backward[backward.length - 1]!.prev_id !== null && steps < MAX_STEPS; steps++) {
    const prev = (await context.kb("getTrace", { id: backward[backward.length - 1]!.prev_id })) as TraceRow | null;
    if (prev === null || seenBack.has(prev.id as string)) break;
    seenBack.add(prev.id as string);
    backward.push(prev);
  }
  // Reversed, that is `[root, ..., start]` -- the chain root-to-start, known
  // outright with no forward query, and `start` is always its last entry.
  const known = backward.slice().reverse();
  const position = known.length - 1;

  // Forward-continuation: one successor PAST `start` at a time, the only
  // segment the backward walk above never visited. One page of successors
  // per hop tells "exactly one" from "a fork" and, on a fork, names its
  // branches -- all of them up to `MAX_BRANCHES`, `truncated` beyond.
  const rows: TraceRow[] = known.slice();
  const seenForward = new Set<string>(rows.map((row) => row.id as string));
  let forked = false;
  let branches: string[] = [];
  let branchesTruncated = false;
  let cursor = rows[rows.length - 1]!;
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    const successors = (await context.kb("listTraces", {
      parent_id: null,
      prev_id: cursor.id,
      depth: null,
      query_contains: null,
      after_created_at: null,
      after_id: null,
      limit: MAX_BRANCHES,
    })) as { rows: TraceRow[]; has_more: boolean };
    if (successors.rows.length === 0) break;
    if (successors.rows.length > 1) {
      forked = true;
      branches = successors.rows.map((row) => row.id as string);
      branchesTruncated = successors.has_more;
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

  return {
    chain,
    position,
    chain_length: chain.length,
    ...(forked ? { forked: true, branches } : {}),
    ...(branchesTruncated
      ? { compat_warnings: [{ code: "truncated", field: "branches", detail: `more than ${MAX_BRANCHES} traces continue from the fork` }] }
      : {}),
  };
}
