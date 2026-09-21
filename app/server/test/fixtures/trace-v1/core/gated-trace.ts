// Owned core child for the #28 trace kernel. Runs INSIDE the real gate.
//
// Adapted from ../../read-cursor-v1/core/gated-cursor.ts: same ops-array
// dispatch over the real `context` facade, same boundary trace recording.
// No dataset surgery harness is needed here -- every case this smoke test
// covers is reachable through the real API alone.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ facade?: "context" | "publication" | "taxonomy"; method: string; request: any }>;
  clockMs?: number | number[] | "throw";
};

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openContextWriter } = await import(servicePath);

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
