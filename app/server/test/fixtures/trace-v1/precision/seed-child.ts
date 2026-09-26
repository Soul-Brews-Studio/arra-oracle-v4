// Owned gated child for the trace-v1 precision fixtures. Runs INSIDE the
// real inherited writer gate.
//
// Shaped after the accepted `fixtures/trace-v1/core/gated-trace.ts`: same
// ops-array dispatch over the real `context` facade, same `insertRawTrace` /
// `insertRawHit` harness shapes (kept byte-for-byte compatible with that
// file's request keys, e.g. `*_millis` / `captured_at_micros`, so a reader who
// knows one script already knows this one). INDEPENDENT of that file on
// purpose -- it is owned by the ownership/recovery lanes running in parallel
// tonight, and a shared script two lanes both edit is how one slice's changes
// quietly become the other's.
//
// Extra harness surgery this file adds: an ADMISSION PROBE for both raw
// inserts (does the ENGINE accept an out-of-Gregorian-range timestamp or a
// NaN/Infinity float, independent of what the kernel would do with it), a
// generic `readRawRows`, and a `snapshot` for before/after write proofs.
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
const { rawRows } = await import(new URL("../../../../src/publication/storage.ts", import.meta.url).pathname);

let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const harnessTable = async (name: string) => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable(name);
  await tbl.checkoutLatest();
  return tbl;
};

function hitColumns(request: Record<string, unknown>): Record<string, unknown[]> {
  return {
    workspace_name: [request.workspace_name],
    trace_id: [request.trace_id],
    kind: [request.kind],
    ref: [request.ref],
    target: [request.target],
    line_start: [request.line_start ?? null],
    line_end: [request.line_end ?? null],
    excerpt: [request.excerpt ?? null],
    content_hash: [request.content_hash ?? null],
    captured_at: [request.captured_at_micros != null ? BigInt(request.captured_at_micros as string) : null],
    note: [request.note ?? null],
    position: [BigInt(request.position as string)],
  };
}

/** JSON has no wire spelling for NaN/Infinity, so the plan carries a string
 *  MARKER for these ("__NaN__", "__Infinity__", "__-Infinity__") -- a bare
 *  `JSON.stringify(NaN)` would already have collapsed to `null` before this
 *  child ever saw it, silently losing the exact value the test means to
 *  plant. */
function nonFiniteMarker(value: unknown): number | null {
  if (value === "__NaN__") return NaN;
  if (value === "__Infinity__") return Infinity;
  if (value === "__-Infinity__") return -Infinity;
  return (value as number | null) ?? null;
}

function traceColumns(request: Record<string, unknown>): Record<string, unknown[]> {
  return {
    id: [request.id],
    name: [request.name ?? "trace"],
    workspace_name: [request.workspace_name],
    session_name: [request.session_name ?? null],
    peer_name: [request.peer_name ?? null],
    query: [request.query ?? "q"],
    mode: [request.mode ?? null],
    session_id: [request.session_id ?? null],
    session_from_ts: [request.session_from_ts_millis != null ? BigInt(request.session_from_ts_millis as string) : null],
    session_to_ts: [request.session_to_ts_millis != null ? BigInt(request.session_to_ts_millis as string) : null],
    friction_score: [nonFiniteMarker(request.friction_score)],
    confidence: [request.confidence ?? null],
    parent_id: [request.parent_id ?? null],
    prev_id: [request.prev_id ?? null],
    depth: [BigInt(request.depth as string ?? "0")],
    status: [request.status ?? "open"],
    h_metadata: [request.h_metadata ?? null],
    internal_metadata: [request.internal_metadata ?? null],
    created_at: [BigInt(request.created_at_millis as string ?? "0")],
    updated_at: [BigInt(request.updated_at_millis as string ?? "0")],
  };
}

const harness: Record<string, (request: any) => Promise<unknown>> = {
  async readRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    return rows.map((r: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)]),
      ),
    );
  },
  async insertRawHit(request) {
    const tbl = await harnessTable("trace_hits");
    await tbl.add(tableFromArrays(hitColumns(request) as never) as never);
    return { planted: true };
  },
  async insertRawTrace(request) {
    const tbl = await harnessTable("traces");
    await tbl.add(tableFromArrays(traceColumns(request) as never) as never);
    return { planted: true };
  },
  /** ADMISSION PROBE: attempts the raw insert and reports whether the ENGINE
   *  accepted it, without asserting any kernel behaviour on a value the
   *  kernel was never given. */
  async probeRawHit(request) {
    const tbl = await harnessTable("trace_hits");
    try {
      await tbl.add(tableFromArrays(hitColumns(request) as never) as never);
      return { admitted: true, version: await tbl.version() };
    } catch (error) {
      const shaped = error as { name?: string; message?: string };
      return { admitted: false, refusal: { name: shaped.name ?? null, message: String(shaped.message ?? error) } };
    }
  },
  async probeRawTrace(request) {
    const tbl = await harnessTable("traces");
    try {
      await tbl.add(tableFromArrays(traceColumns(request) as never) as never);
      return { admitted: true, version: await tbl.version() };
    } catch (error) {
      const shaped = error as { name?: string; message?: string };
      return { admitted: false, refusal: { name: shaped.name ?? null, message: String(shaped.message ?? error) } };
    }
  },
  async snapshot(request: { tables: string[] }) {
    const snapshot: Record<string, unknown> = {};
    for (const name of request.tables) {
      const tbl = await harnessTable(name);
      snapshot[name] = { version: await tbl.version(), rows: await tbl.countRows() };
    }
    return snapshot;
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

console.log(JSON.stringify(results));
await service.close();
