// Owned gated child for #30's embed-worker tests (`search-chunk-embed-worker.test.ts`).
// Runs INSIDE the real gate. Shaped after the accepted
// `core/gated-search.ts`: the same ops-array dispatch over `publication`,
// `context` and `harness`, plus:
//
//  - `payload.embedTimeoutMs` sets `ARRA_EMBED_TIMEOUT_MS` in THIS process's
//    env BEFORE `service.ts` (and therefore `service.embedPendingChunks.ts`)
//    is ever imported -- the same "env read at import" convention
//    `storage.ts`'s `ARRA_DATA_DIR` already relies on, so a test can force a
//    short timeout without waiting out the real 30s default.
//  - `payload.embedderMode` selects a STUB embedder, never a real network
//    call: "none" (omit the option entirely), "fixed" (deterministic
//    per-text vectors, call args recorded), "hang" (a promise that never
//    settles), "reject-once" (the first call rejects, every later call
//    succeeds with a fixed vector).
//  - `op.concurrent: Op[]` runs every listed op via `Promise.all` and
//    records each sub-result under its own index -- how the hang test
//    proves `publishRevision` is never blocked by a concurrent
//    `embedPendingChunks` call stuck in its embedder.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<
    | { facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any }
    | { concurrent: Array<{ facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any }> }
  >;
  clockMs?: number;
  revisionIds?: string[];
  embedTimeoutMs?: number;
  embedderMode?: "none" | "fixed" | "hang" | "reject-once" | "always-fail";
  embedDims?: number;
};

if (payload.embedTimeoutMs !== undefined) {
  process.env.ARRA_EMBED_TIMEOUT_MS = String(payload.embedTimeoutMs);
}

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openContextWriter } = await import(servicePath);
const { rawRows } = await import(new URL("../../../../src/publication/storage.ts", import.meta.url).pathname);
const { connect } = await import("@lancedb/lancedb");

const DIMS = payload.embedDims ?? 384;
const embedCalls: string[][] = [];
let rejectOnceUsed = false;

function fixedVector(seed: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => ((seed + i) % 97) / 97);
}

const embedder =
  payload.embedderMode === undefined || payload.embedderMode === "none"
    ? undefined
    : async (texts: string[], _signal?: AbortSignal): Promise<number[][]> => {
        embedCalls.push(texts);
        if (payload.embedderMode === "hang") {
          return new Promise<number[][]>(() => {
            /* never resolves */
          });
        }
        if (payload.embedderMode === "reject-once" && !rejectOnceUsed) {
          rejectOnceUsed = true;
          throw new Error("503 service unavailable");
        }
        if (payload.embedderMode === "always-fail") {
          throw new Error("503 service unavailable, every time");
        }
        return texts.map((text, i) => fixedVector(text.length + i));
      };

let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const harnessTable = async (name: string) => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable(name);
  await tbl.checkoutLatest();
  return tbl;
};

const harness: Record<string, (request: any) => Promise<unknown>> = {
  async readRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    return rows.map((r: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v === null || v === undefined) {
          out[k] = null;
        } else if (typeof v === "bigint") {
          out[k] = v.toString(10);
        } else if (k === "embedding" || k === "term_ids") {
          // Only ever inspected for shape (populated vs not) in this fixture,
          // never for exact values -- a raw Arrow Vector's own `.toArray()`
          // is enough here, unlike `core/gated-search.ts`'s more exhaustive
          // shape reporting.
          out[k] = typeof (v as { toArray?: unknown }).toArray === "function"
            ? Array.from((v as { toArray(): unknown[] }).toArray())
            : v;
        } else {
          out[k] = v;
        }
      }
      return out;
    });
  },
};

const trace: string[] = [];
const results: Record<string, unknown> = {};

const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; message?: string; toJSON?: () => { version?: string; message?: string } };
  let version: string | null = null;
  let message: string | null = null;
  try {
    const j = typeof e.toJSON === "function" ? e.toJSON() : undefined;
    version = j?.version ?? null;
    message = j?.message ?? e.message ?? null;
  } catch {
    version = null;
    message = e?.message ?? null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version, message };
};

let revisionIndex = 0;
const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds?.[revisionIndex++] ?? `fallback${String(revisionIndex).padStart(12, "0")}`,
  clock: () => payload.clockMs ?? 1_758_412_800_000,
  sourceNamespace: null,
  embedder,
  onContextBoundary: async (boundary: string) => {
    trace.push(boundary);
  },
});

type Op = { facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any };

async function runOp(op: Op): Promise<Record<string, unknown>> {
  if (op.facade === "harness") {
    return { ok: true, value: await harness[op.method]!(op.request) };
  }
  const facade = (service as Record<string, Record<string, (b: Uint8Array) => Promise<unknown>>>)[
    op.facade ?? "context"
  ];
  const call = facade?.[op.method];
  if (typeof call !== "function") return { ok: false, code: "no_such_method" };
  try {
    return { ok: true, value: await call(new TextEncoder().encode(JSON.stringify(op.request))) };
  } catch (error) {
    return { ok: false, ...describeError(error) };
  }
}

try {
  for (const [index, op] of payload.ops.entries()) {
    const label = `op${index}`;
    if ("concurrent" in op) {
      const batchStarted = Bun.nanoseconds();
      const settled = await Promise.all(
        op.concurrent.map(async (sub) => {
          const subStarted = Bun.nanoseconds();
          const outcome = await runOp(sub);
          return { ...outcome, elapsedMs: (Bun.nanoseconds() - subStarted) / 1_000_000 };
        }),
      );
      results[label] = { concurrent: settled, elapsedMs: (Bun.nanoseconds() - batchStarted) / 1_000_000 };
      continue;
    }
    results[label] = await runOp(op);
  }
} finally {
  results.trace = trace;
  results.embedCalls = embedCalls;
}

console.log(JSON.stringify(results));
await service.close();
