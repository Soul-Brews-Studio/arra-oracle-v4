// Owned core child for the session-link kernel. Runs INSIDE the real gate.
//
// Adapted from the accepted read-cursor gated child: same op-driving loop,
// same clock-injection discipline, same trace/results envelope. Trimmed to
// what the session-link smoke test actually needs -- no message reshaping
// surgery, since this slice never touches messages.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
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

const trace: string[] = [];
const counts = new Map<string, number>();
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

/** The clock is OPERATOR configuration, supplied the same way a deployment would. */
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
    const seen = (counts.get(boundary) ?? 0) + 1;
    counts.set(boundary, seen);
  },
});

const harness: Record<string, (request: any) => Promise<unknown>> = {
  /** Raw rows as TEXT so a bigint column survives JSON without loss. */
  async readRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    return rows.map((r: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)]),
      ),
    );
  },
  /**
   * Insert `session_links` rows DIRECTLY, bypassing every service-level
   * check (self-link, endpoint existence, cycle detection). Used ONLY to
   * plant retained state a well-behaved writer could never have produced
   * itself -- a stored back-edge cycle, or a single node with more out-edges
   * than the cycle walk's bound -- so the WALK's own defenses are what gets
   * measured, not whatever wrote the fixture.
   */
  async insertRawSessionLinks(request: {
    rows: Array<{
      id: string;
      workspace_name: string;
      from_session_name: string;
      to_session_name: string;
      relation: string;
      evidence_ref: string | null;
      created_by_peer_name: string | null;
      created_at_micros: string;
    }>;
  }) {
    const tbl = await harnessTable("session_links");
    const columns: Record<string, unknown[]> = {
      id: [], workspace_name: [], from_session_name: [], to_session_name: [],
      relation: [], evidence_ref: [], created_by_peer_name: [], created_at: [],
    };
    for (const row of request.rows) {
      columns.id!.push(row.id);
      columns.workspace_name!.push(row.workspace_name);
      columns.from_session_name!.push(row.from_session_name);
      columns.to_session_name!.push(row.to_session_name);
      columns.relation!.push(row.relation);
      columns.evidence_ref!.push(row.evidence_ref);
      columns.created_by_peer_name!.push(row.created_by_peer_name);
      columns.created_at!.push(BigInt(row.created_at_micros));
    }
    await tbl.add(tableFromArrays(columns as never) as never);
    return { inserted: request.rows.length };
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
  results.writerKeys = Object.keys(service).sort();
  results.contextMethods = Object.keys(service.context).sort();
  results.trace = trace;
  results.clockCalls = clockCalls;
}

console.log(JSON.stringify(results));
await service.close();
