// Owned test child for the #30 search-chunk kernel. Runs INSIDE the real
// gate. Adapted from the #71 read-cursor kernel's gated-cursor.ts: same
// generic op-dispatch shape, so a driver in the test file looks identical.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any }>;
  clockMs?: number;
  revisionIds?: string[];
};

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openContextWriter } = await import(servicePath);
const { rawRows } = await import(new URL("../../../../src/publication/storage.ts", import.meta.url).pathname);
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

let revisionIndex = 0;
const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds?.[revisionIndex++] ?? `fallback${String(revisionIndex).padStart(12, "0")}`,
  clock: () => payload.clockMs ?? 1_758_412_800_000,
  sourceNamespace: null,
  onContextBoundary: async (boundary: string) => {
    trace.push(boundary);
  },
});

const harness: Record<string, (request: any) => Promise<unknown>> = {
  /** Raw rows as TEXT so a bigint or list column survives JSON without loss. */
  async readRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    // EMPIRICAL, per the #30 kernel brief: `decodeArrowRows`'s generic
    // `vector.get(row)` fallback does NOT hand back a plain JS array for the
    // `list<utf8?>` column -- it hands back a raw apache-arrow `Vector`
    // object (typeof "object", Array.isArray === false, exposing `.toArray()`
    // and iterable). Reported here as `raw_shape` rather than silently
    // normalized, so the test can assert on what was actually measured.
    return rows.map((r: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v === null || v === undefined) {
          out[k] = null;
        } else if (Array.isArray(v)) {
          out[k] = v.map((item) => (item === null ? null : String(item)));
        } else if (k === "term_ids") {
          out.term_ids_raw_shape = {
            typeofValue: typeof v,
            constructorName: (v as { constructor?: { name?: string } }).constructor?.name ?? null,
            isArray: Array.isArray(v),
            hasToArray: typeof (v as { toArray?: unknown }).toArray === "function",
          };
          out[k] = typeof (v as { toArray?: unknown }).toArray === "function"
            ? (v as { toArray(): unknown[] }).toArray().map((item) => (item === null ? null : String(item)))
            : String(v);
        } else {
          out[k] = String(v);
        }
      }
      return out;
    });
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
  results.contextMethods = Object.keys(service.context).sort();
  results.trace = trace;
}

console.log(JSON.stringify(results));
await service.close();
