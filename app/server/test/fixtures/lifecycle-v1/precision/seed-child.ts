// Owned gated child for the lifecycle-v1 precision fixtures. Runs INSIDE the
// real inherited writer gate.
//
// Shaped after the accepted `fixtures/lifecycle-v1/core/gated-lifecycle.ts`:
// same ops-array dispatch across `publication` (to set up a real node/head via
// `publishRevision`) and `context` (`supersedeNode`/`retireNode`/
// `getRecallEligibility`/`listLifecycleHistory`), same clock-injection and
// revision-id-injection discipline. INDEPENDENT of that file on purpose -- it
// is owned by the ownership/recovery lanes running in parallel tonight, and a
// shared script two lanes both edit is how one slice's changes quietly become
// the other's.
//
// Extra harness surgery this file adds, none of which the core child needs:
// planting a `supersede_log` row at an arbitrary `id` (to reach the Int64
// ceiling without allocating 2^63 real events), a sub-millisecond
// `superseded_at` remainder, an out-of-Gregorian-range `superseded_at`, and a
// half-null `new_id`/`new_revision_id` pair -- all ENGINE-ADMITTED corruption
// no service call can produce, plus a raw table snapshot to prove a refused
// allocation left the table untouched.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any }>;
  revisionIds?: string[];
  clockMs?: number | number[];
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

/** Exactly the 16 physical `supersede_log` columns, in physical order. */
const SUPERSEDE_LOG_FIELDS = [
  "id", "workspace_name", "old_id", "old_revision_id", "old_title", "old_type", "old_source",
  "new_id", "new_revision_id", "new_title", "new_source", "reason", "peer_name",
  "superseded_at", "operation_id", "h_metadata",
] as const;

type RawSupersedeRow = {
  id: string; // decimal text, converted to BigInt below
  workspace_name: string;
  old_id: string;
  old_revision_id: string;
  old_title: string | null;
  old_type: string | null;
  new_id: string | null;
  new_revision_id: string | null;
  new_title: string | null;
  reason: string;
  peer_name: string | null;
  superseded_at_micros: string; // decimal text, converted to BigInt below
  operation_id: string;
};

function supersedeColumns(rows: RawSupersedeRow[]): Record<string, unknown[]> {
  const columns: Record<string, unknown[]> = Object.fromEntries(SUPERSEDE_LOG_FIELDS.map((f) => [f, []]));
  for (const row of rows) {
    columns.id!.push(BigInt(row.id));
    columns.workspace_name!.push(row.workspace_name);
    columns.old_id!.push(row.old_id);
    columns.old_revision_id!.push(row.old_revision_id);
    columns.old_title!.push(row.old_title ?? null);
    columns.old_type!.push(row.old_type ?? null);
    columns.old_source!.push(null);
    columns.new_id!.push(row.new_id ?? null);
    columns.new_revision_id!.push(row.new_revision_id ?? null);
    columns.new_title!.push(row.new_title ?? null);
    columns.new_source!.push(null);
    columns.reason!.push(row.reason);
    columns.peer_name!.push(row.peer_name ?? null);
    columns.superseded_at!.push(BigInt(row.superseded_at_micros));
    columns.operation_id!.push(row.operation_id);
    columns.h_metadata!.push(null);
  }
  return columns;
}

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
  /** Plant `supersede_log` rows DIRECTLY, bypassing the allocator, the pin
   *  check and every other service-level rule -- the only way to reach an
   *  arbitrary `id` (the Int64 ceiling, without allocating 2^63 real events),
   *  a corrupt `superseded_at`, or a half-null successor pair. */
  async insertRawSupersedeLog(request: { rows: RawSupersedeRow[] }) {
    const tbl = await harnessTable("supersede_log");
    await tbl.add(tableFromArrays(supersedeColumns(request.rows) as never) as never);
    return { inserted: request.rows.length };
  },
  /** ADMISSION PROBE: attempts the same raw insert and reports whether the
   *  ENGINE accepted it, without asserting any kernel behaviour on a value
   *  the kernel was never given. */
  async probeSupersedeLog(request: { rows: RawSupersedeRow[] }) {
    const tbl = await harnessTable("supersede_log");
    try {
      await tbl.add(tableFromArrays(supersedeColumns(request.rows) as never) as never);
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
