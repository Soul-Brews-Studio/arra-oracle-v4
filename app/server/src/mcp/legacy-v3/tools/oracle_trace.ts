import { CompatError } from "../compat-error";
import { ensureSpeaker } from "../ensureSpeaker";
import type { V3ToolContext } from "../handlers";
import { derivedId } from "../ids.derivedId";
import { randomId } from "../ids.randomId";
import { buildTraceHits } from "../trace-hits";

const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

const slugOf = (query: string): string => {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200);
  return slug === "" ? "trace" : slug;
};

/** A3/D9 FORMAT check only. A legacy (non-nanoid21) pointer can never
 *  resolve in v4, so it fails fast as `legacy_id_unknown`; EXISTENCE of a
 *  well-formed id is the kernel's own job (`createTrace` refuses an unknown
 *  parent/prev with `invalid_reference`, which `fromKernel` renders as
 *  v3-style text) -- checking it here too would be a second, divergent
 *  definition of "not found". */
function traceIdOrLegacyUnknown(id: string, field: "parentTraceId" | "prevTraceId", tool: string): string {
  if (!NANOID21.test(id)) {
    throw new CompatError(tool, "legacy_id_unknown", `Trace ${id} not found`, "v3 trace ids do not exist in v4 (no v3 corpus import, D9)", { path: `/${field}` });
  }
  return id;
}

/**
 * `oracle_trace` (70 real calls; V3-PARITY.md §4.2; v3 `src/tools/trace.ts:
 * 29-50,167-183`, store `trace/store.ts:18-66`). One `createTrace` call:
 * full-length commits and issues become indexed hits (`../trace-hits.ts`),
 * everything else stays in `h_metadata.legacy`. Traces are immutable, so a
 * follow-up links at CREATION time via `parentTraceId`/`prevTraceId`
 * (`prevTraceId` replaces v3's separate `oracle_trace_link`, D11).
 */
export async function oracle_trace(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query === "") {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /query: query is required", "v3's own rule: a nonblank query", { path: "/query" });
  }

  const parentId =
    typeof args.parentTraceId === "string" && args.parentTraceId !== ""
      ? traceIdOrLegacyUnknown(args.parentTraceId, "parentTraceId", context.tool)
      : null;
  const prevId =
    typeof args.prevTraceId === "string" && args.prevTraceId !== ""
      ? traceIdOrLegacyUnknown(args.prevTraceId, "prevTraceId", context.tool)
      : null;

  const parent = parentId === null ? null : ((await context.kb("getTrace", { id: parentId })) as Record<string, unknown> | null);
  const depth = parent === null ? "0" : String(BigInt(parent.depth as string) + 1n);

  const author = await ensureSpeaker(context, args);

  const idempotencyKey = args.idempotency_key;
  if (idempotencyKey !== undefined && idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey === "")) {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /idempotency_key", "idempotency_key must be a nonempty string", { path: "/idempotency_key" });
  }
  const id = typeof idempotencyKey === "string" ? derivedId(context.bank, "trace", context.tool, idempotencyKey) : randomId();
  const name = `${slugOf(query)}-${id.slice(0, 6)}`;

  const sessionId = typeof args.sessionId === "string" && args.sessionId !== "" ? `claude-code:${args.sessionId}` : null;
  const built = buildTraceHits(args);

  const request = {
    id,
    name,
    session_name: null,
    peer_name: author,
    query,
    mode: null,
    session_id: sessionId,
    session_from_ts: null,
    session_to_ts: null,
    friction_score: null,
    confidence: null,
    parent_id: parentId,
    prev_id: prevId,
    depth,
    status: "complete",
    h_metadata: JSON.stringify({
      project: typeof args.project === "string" ? args.project : null,
      query_type: typeof args.queryType === "string" ? args.queryType : null,
      scope: typeof args.scope === "string" ? args.scope : null,
      agent_count: typeof args.agentCount === "number" ? args.agentCount : null,
      duration_ms: typeof args.durationMs === "number" ? args.durationMs : null,
      legacy: built.legacy,
    }),
    internal_metadata: JSON.stringify({ adapter: "arra-v3-compat/1" }),
    hits: built.hits,
  };

  const created = (await context.kb("createTrace", request)) as { outcome: string; row?: { id: string } };
  if (created.outcome === "conflict" || created.row === undefined) {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /idempotency_key", "this idempotency_key was already used for a different trace", { path: "/idempotency_key" });
  }

  return {
    success: true,
    trace_id: created.row.id,
    depth: Number(depth),
    summary: built.summary,
    message: `Trace logged. Use oracle_trace_get with trace_id="${created.row.id}" to explore dig points.`,
  };
}
