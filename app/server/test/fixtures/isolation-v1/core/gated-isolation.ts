// Owned test child for the two-workspace isolation proof (#10). Runs INSIDE
// the real gate, against the full four-facade bundle (`openEvidenceWriter`):
// publication, taxonomy, context and evidence, all one owner. Modelled
// directly on the #30 search-chunk kernel's `gated-search.ts` -- same generic
// op-dispatch shape, so a driver in the test file looks identical to every
// other kernel's real-persistence lane.
//
// This file adds NO new assertions of its own: it only relays each facade
// call's outcome (or governed error) back to the parent as JSON, plus a raw
// harness read for setup verification. Every isolation claim is made by the
// test file, from what this script reports.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ facade?: "context" | "publication" | "taxonomy" | "evidence" | "harness"; method: string; request: any }>;
  clockMs?: number;
  revisionIds?: string[];
};

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openEvidenceWriter } = await import(servicePath);
const { rawRows } = await import(new URL("../../../../src/publication/storage.ts", import.meta.url).pathname);
const { connect } = await import("@lancedb/lancedb");

let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const harnessTable = async (name: string) => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable(name);
  await tbl.checkoutLatest();
  return tbl;
};

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
const service = await openEvidenceWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds?.[revisionIndex++] ?? `fallback${String(revisionIndex).padStart(12, "0")}`,
  clock: () => payload.clockMs ?? 1_758_412_800_000,
  sourceNamespace: null,
});

/** Raw rows as TEXT, so a bigint or list column survives JSON without loss. */
const harness: Record<string, (request: any) => Promise<unknown>> = {
  async readRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    return rows.map((r: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v === null || v === undefined) {
          out[k] = null;
        } else if (Array.isArray(v)) {
          out[k] = v.map((item) => (item === null ? null : String(item)));
        } else if (typeof v === "object" && typeof (v as { toArray?: unknown }).toArray === "function") {
          out[k] = (v as { toArray(): unknown[] }).toArray().map((item) => (item === null ? null : String(item)));
        } else {
          out[k] = String(v);
        }
      }
      return out;
    });
  },
  /** Count of raw rows matching a predicate, across the whole table -- used
   *  ONLY to prove setup (two colliding rows genuinely exist), never as an
   *  isolation oracle by itself. */
  async countRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    return rows.length;
  },
};

const results: Record<string, unknown> = {};

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
  results.writerKeys = Object.keys(service).sort();
}

console.log(JSON.stringify(results));
await service.close();
