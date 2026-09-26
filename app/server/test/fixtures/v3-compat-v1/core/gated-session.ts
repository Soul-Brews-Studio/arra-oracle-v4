// Owned core child for the v3-compat-v1 fixture family (#31 legacy adapters,
// docs/overnight/V3-PARITY.md slice VA).
//
// Adapted from ../../trace-v1/core/gated-trace.ts: same ops-array dispatch
// over the real facade, run INSIDE the real writer gate on fd 42. This one
// opens `openContextWriter`, which bundles all three facades the v3-compat
// acceptance session ever needs to seed directly (publication, taxonomy,
// context) -- unlike a single kernel's own core child, this file is scoped to
// the whole family so V1..V10's own tests can share it instead of each
// growing a second copy under test/mcp-v3-*.test.ts.
//
// argv: [datasetRoot, payloadJson]
// payload: { ops: Array<{ facade?: "context"|"publication"|"taxonomy"; method: string; request: unknown }>,
//            clockMs?: number | number[] | "throw" }
//
// stdout: one JSON line { op0: {ok,value}|{ok:false,...error}, op1: ..., clockCalls }
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ facade?: "context" | "publication" | "taxonomy"; method: string; request: unknown }>;
  clockMs?: number | number[] | "throw";
};

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openContextWriter } = await import(servicePath);

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

/** The clock is OPERATOR configuration, same discipline as gated-trace.ts:
 *  `"throw"` proves a path never samples it, deterministic replay never
 *  depends on wall-clock time. */
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
  newRevisionId: () => "unusedrevisionid00000",
  clock,
  sourceNamespace: null,
});

try {
  for (const [index, op] of payload.ops.entries()) {
    const label = `op${index}`;
    const facade = (service as Record<string, Record<string, (b: Uint8Array) => Promise<unknown>>>)[
      op.facade ?? "publication"
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
  results.clockCalls = clockCalls;
}

// Evidence is printed BEFORE release so a close failure still leaves the
// parent something to read -- but the close itself is NOT swallowed.
console.log(JSON.stringify(results));
await service.close();
