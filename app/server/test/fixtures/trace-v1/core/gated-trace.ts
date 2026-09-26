// Owned core child for the #28 trace kernel. Runs INSIDE the real gate.
//
// Adapted from ../../read-cursor-v1/core/gated-cursor.ts: same ops-array
// dispatch over the real `context` facade, same boundary trace recording.
// A small `harness` facade is also available, same as gated-cursor.ts's,
// for state the real API can never produce: a non-contiguous stored
// `trace_hits.position` (TR-3), a negative stored `position` (TR-7), a
// stored empty-string nullable text column (TR-11), and a stored
// `parent_id`/`prev_id` outside the nanoid21 namespace (TR-4).
import { readArgPayload } from "../../../helpers/argv.readArgPayload";
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  ops: Array<{ facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any }>;
  clockMs?: number | number[] | "throw";
};

const { connect } = await import("@lancedb/lancedb");
const { tableFromArrays } = await import("apache-arrow");
const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openContextWriter } = await import(servicePath);

let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const harnessTable = async (name: string) => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable(name);
  await tbl.checkoutLatest();
  return tbl;
};

const harness: Record<string, (request: any) => Promise<unknown>> = {
  /** Plant one `trace_hits` row directly, bypassing `createTrace` entirely --
   *  the only way to reach a stored position or a stored empty string the
   *  real write path can never produce (positions are always assigned
   *  0..n-1 contiguously and non-negative; the request grammar refuses "" for
   *  every non-empty-required nullable text column). */
  async insertRawHit(request) {
    const tbl = await harnessTable("trace_hits");
    await tbl.add(
      tableFromArrays({
        workspace_name: [request.workspace_name],
        trace_id: [request.trace_id],
        kind: [request.kind],
        ref: [request.ref],
        target: [request.target],
        line_start: [request.line_start ?? null],
        line_end: [request.line_end ?? null],
        excerpt: [request.excerpt ?? null],
        content_hash: [request.content_hash ?? null],
        captured_at: [request.captured_at_micros != null ? BigInt(request.captured_at_micros) : null],
        note: [request.note ?? null],
        position: [BigInt(request.position)],
      } as never) as never,
    );
    return { planted: true };
  },
  /** Plant one full `traces` row directly, bypassing `createTrace` entirely --
   *  the only way to reach a stored `parent_id`/`prev_id` outside the
   *  nanoid21 namespace the real write path can never produce. */
  async insertRawTrace(request) {
    const tbl = await harnessTable("traces");
    await tbl.add(
      tableFromArrays({
        id: [request.id],
        name: [request.name ?? "trace"],
        workspace_name: [request.workspace_name],
        session_name: [request.session_name ?? null],
        peer_name: [request.peer_name ?? null],
        query: [request.query ?? "q"],
        mode: [request.mode ?? null],
        session_id: [request.session_id ?? null],
        session_from_ts: [request.session_from_ts_millis != null ? BigInt(request.session_from_ts_millis) : null],
        session_to_ts: [request.session_to_ts_millis != null ? BigInt(request.session_to_ts_millis) : null],
        friction_score: [request.friction_score ?? null],
        confidence: [request.confidence ?? null],
        parent_id: [request.parent_id ?? null],
        prev_id: [request.prev_id ?? null],
        depth: [BigInt(request.depth ?? 0)],
        status: [request.status ?? "open"],
        h_metadata: [request.h_metadata ?? null],
        internal_metadata: [request.internal_metadata ?? null],
        created_at: [BigInt(request.created_at_millis ?? 0)],
        updated_at: [BigInt(request.updated_at_millis ?? 0)],
      } as never) as never,
    );
    return { planted: true };
  },
  /** Same shape as `insertRawTrace`, but ALL requests in ONE `tbl.add` call
   *  (one Arrow batch, one commit) instead of one round trip per row --
   *  scale fixtures for the K5 keyset cursor (docs/overnight/V3-PARITY.md
   *  §5) need hundreds to thousands of rows, and a thousand sequential
   *  single-row commits would make the fixture itself the slow part of the
   *  test. */
  async insertRawTraces(request: { rows: Record<string, unknown>[] }) {
    const tbl = await harnessTable("traces");
    const rows = request.rows;
    await tbl.add(
      tableFromArrays({
        id: rows.map((r) => r.id),
        name: rows.map((r) => r.name ?? "trace"),
        workspace_name: rows.map((r) => r.workspace_name),
        session_name: rows.map((r) => r.session_name ?? null),
        peer_name: rows.map((r) => r.peer_name ?? null),
        query: rows.map((r) => r.query ?? "q"),
        mode: rows.map((r) => r.mode ?? null),
        session_id: rows.map((r) => r.session_id ?? null),
        session_from_ts: rows.map((r) => (r.session_from_ts_millis != null ? BigInt(r.session_from_ts_millis as any) : null)),
        session_to_ts: rows.map((r) => (r.session_to_ts_millis != null ? BigInt(r.session_to_ts_millis as any) : null)),
        friction_score: rows.map((r) => r.friction_score ?? null),
        confidence: rows.map((r) => r.confidence ?? null),
        parent_id: rows.map((r) => r.parent_id ?? null),
        prev_id: rows.map((r) => r.prev_id ?? null),
        depth: rows.map((r) => BigInt((r.depth as any) ?? 0)),
        status: rows.map((r) => r.status ?? "open"),
        h_metadata: rows.map((r) => r.h_metadata ?? null),
        internal_metadata: rows.map((r) => r.internal_metadata ?? null),
        created_at: rows.map((r) => BigInt(r.created_at_millis as any)),
        updated_at: rows.map((r) => BigInt(r.updated_at_millis as any)),
      } as never) as never,
    );
    return { planted: rows.length };
  },
};

const trace: string[] = [];
const results: Record<string, unknown> = {};
let clockCalls = 0;

const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; toJSON?: () => { version?: string; message?: string } };
  let version: string | null = null;
  let message: string | null = null;
  try {
    const j = typeof e.toJSON === "function" ? e.toJSON() : undefined;
    version = j?.version ?? null;
    message = j?.message ?? null;
  } catch {
    version = null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version, message };
};

/** The clock is OPERATOR configuration, supplied the same way a deployment
 *  would. `"throw"` proves a path never samples it: a replay or a conflict
 *  that quietly took a reading would fail loudly here. */
const clock = () => {
  const sample = payload.clockMs ?? 1_758_412_800_000;
  clockCalls += 1;
  if (sample === "throw") throw new Error("clock sampled on a path that must not sample it");
  if (Array.isArray(sample)) {
    const value = sample[Math.min(clockCalls - 1, sample.length - 1)];
    if (value === undefined) throw new Error("clock samples exhausted");
    return value;
  }
  return sample;
};

const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => "unusedrevision000000",
  clock,
  sourceNamespace: null,
  onContextBoundary: async (boundary: string) => {
    trace.push(boundary);
  },
});

try {
  for (const [index, op] of payload.ops.entries()) {
    const label = `op${index}`;
    if (op.facade === "harness") {
      try {
        results[label] = { ok: true, value: await harness[op.method]!(op.request) };
      } catch (error) {
        results[label] = { ok: false, ...describeError(error) };
      }
      continue;
    }
    const facade = (service as Record<string, Record<string, (b: Uint8Array) => Promise<unknown>>>)[
      op.facade ?? "context"
    ];
    const call = facade?.[op.method];
    if (typeof call !== "function") {
      results[label] = { ok: false, code: "no_such_method" };
      continue;
    }
    try {
      results[label] = { ok: true, value: await call(new TextEncoder().encode(JSON.stringify(op.request))) };
    } catch (error) {
      results[label] = { ok: false, ...describeError(error) };
    }
  }
} finally {
  results.trace = trace;
  results.clockCalls = clockCalls;
}

// Evidence is printed BEFORE release so a close failure still leaves the
// parent something to read -- but the close itself is NOT swallowed.
console.log(JSON.stringify(results));
await service.close();
