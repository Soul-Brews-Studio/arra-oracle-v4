// Owned core child for the #28 trace kernel. Runs INSIDE the real gate.
//
// Adapted from ../../read-cursor-v1/core/gated-cursor.ts: same ops-array
// dispatch over the real `context` facade, same boundary trace recording.
// A small `harness` facade is also available, same as gated-cursor.ts's,
// for the ONE case not reachable through the real API alone: planting a
// non-contiguous stored `trace_hits.position` to prove the read path (TR-3)
// refuses it rather than silently serving a gap.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
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
   *  the only way to reach a stored position the real write path can never
   *  produce (it always assigns 0..n-1 contiguously). */
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
