// Owned core child for the #29 node-lifecycle kernel. Runs INSIDE the real
// gate. Adapted from fixtures/read-cursor-v1/core/gated-cursor.ts: same
// dispatch loop, same trace/results shape, minus the cursor-only harness
// surgery this kernel does not need.
import { readArgPayload } from "../../../helpers/argv.readArgPayload";
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  ops: Array<{ facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any }>;
  revisionIds?: string[];
  clockMs?: number | number[];
  /** Command a boundary hook to throw, to deterministically LEAVE AN ORPHAN
   *  revision (append landed, head never moved) without a real crash. */
  throwAtBoundary?: { boundary: string; occurrence: number };
};

const { openContextWriter } = await import(
  new URL("../../../../src/publication/service.ts", import.meta.url).pathname
);
const { rawRows } = await import(
  new URL("../../../../src/publication/storage.ts", import.meta.url).pathname
);
const { connect } = await import("@lancedb/lancedb");

let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const harnessTable = async (name: string) => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable(name);
  await tbl.checkoutLatest();
  return tbl;
};

const trace: string[] = [];
const results: Record<string, unknown> = {};
let clockCalls = 0;
let revisionIndex = 0;

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
  if (Array.isArray(sample)) {
    const value = sample[Math.min(clockCalls - 1, sample.length - 1)];
    if (value === undefined) throw new Error("clock samples exhausted");
    return value;
  }
  return sample;
};

const boundaryCounts = new Map<string, number>();

const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds?.[revisionIndex++] ?? `fallbackrev${String(revisionIndex).padStart(9, "0")}`,
  clock,
  sourceNamespace: null,
  onContextBoundary: async (boundary: string) => {
    trace.push(boundary);
  },
  onBoundary: async (boundary: string) => {
    const target = payload.throwAtBoundary;
    if (target === undefined || target.boundary !== boundary) return;
    const seen = (boundaryCounts.get(boundary) ?? 0) + 1;
    boundaryCounts.set(boundary, seen);
    if (seen === target.occurrence) throw new Error("commanded orphan-leaving boundary failure");
  },
});

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
};

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
