// Owned gated child for the ac-guards slice (#29 AC4, #27 AC3). Adapted from
// the accepted `fixtures/lifecycle-v1/core/gated-lifecycle.ts`: same
// ops-array dispatch across `publication`/`context`/`taxonomy`, same
// clock-injection and revision-id-injection discipline. Kept as its own file
// (not an edit to the shared core child) for the same reason
// `precision/seed-child.ts` gives: this slice's own harness surgery -- a raw
// `{version, rows}` snapshot per table, borrowed verbatim from that file's
// `snapshot` op -- must never become another lane's silent dependency.
import { readArgPayload } from "../../../helpers/argv.readArgPayload";
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  ops: Array<{
    facade?: "context" | "publication" | "taxonomy" | "harness";
    method: string;
    request: any;
    /** Fix round (verifier finding M8): the transport's real request time,
     *  forwarded as the facade call's SECOND argument -- exactly what
     *  `service.makeReadMethods.ts`/`service.createContextReadMethods.ts` wire
     *  a live request time through as. Needed to exercise `listNodes`'
     *  `eligible_only: true` view (it refuses a missing one) inside the same
     *  read-only batch the AC4 readonly test snapshots. Round 3: also how
     *  the #27 AC3 test asks `getRecallEligibility` at fixed instants instead
     *  of its `Date.now()` fallback. */
    requestTimeMs?: number;
  }>;
  revisionIds?: string[];
  clockMs?: number | number[];
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

const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds?.[revisionIndex++] ?? `fallbackrev${String(revisionIndex).padStart(9, "0")}`,
  clock,
  sourceNamespace: null,
  onContextBoundary: async (boundary: string) => {
    trace.push(boundary);
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
  /** Table version + row count, for every named table -- the "did a read
   *  write" proof the ac-guards #29 AC4 test needs. */
  async snapshot(request: { tables: string[] }) {
    const snapshot: Record<string, unknown> = {};
    for (const name of request.tables) {
      const tbl = await harnessTable(name);
      snapshot[name] = { version: await tbl.version(), rows: await tbl.countRows() };
    }
    return snapshot;
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
    const facade = (service as Record<string, Record<string, (b: Uint8Array, t?: number) => Promise<unknown>>>)[
      op.facade ?? "context"
    ];
    const call = facade?.[op.method];
    if (typeof call !== "function") {
      results[label] = { ok: false, code: "no_such_method" };
      continue;
    }
    try {
      results[label] = {
        ok: true,
        value: await call(new TextEncoder().encode(JSON.stringify(op.request)), op.requestTimeMs),
      };
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
