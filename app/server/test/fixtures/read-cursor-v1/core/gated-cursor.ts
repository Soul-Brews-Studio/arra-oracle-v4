// Owned core child for the #71 read-cursor kernel. Runs INSIDE the real gate.
//
// Records the context boundary trace in firing order and the persisted cursor
// rows separately: a count alone cannot prove WHICH row was written.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any }>;
  clockMs?: number | number[] | "throw";
  factory?: "context" | "evidence";
  failAt?: { boundary: string; occurrence: number };
  /**
   * Deterministic surgery AT a boundary, used to discriminate the post-write
   * readback classes. `after_write` fires strictly between the SDK call and
   * the readback, so no prototype patch or timing window is involved.
   */
  mutateAt?: { boundary: string; occurrence: number; kind: string; public_id: string; new_id?: string };
};

const { connect } = await import("@lancedb/lancedb");
const { tableFromArrays } = await import("apache-arrow");
const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openContextWriter, openEvidenceWriter } = await import(servicePath);
const { rawRows } = await import(new URL("../../../../src/publication/storage.ts", import.meta.url).pathname);

// Test-side dataset surgery, deliberately OUTSIDE the service. The service
// never CREATES a null-pointer cursor row, yet retained ones must remain
// readable and advanceable, so the only way to reach that state is to plant it.
let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const harnessTable = async (name: string) => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable(name);
  await tbl.checkoutLatest();
  return tbl;
};

/** Copy one message row under overrides, preserving every physical type. */
const reshapeMessage = async (publicId: string, mode: "delete" | "duplicate" | "reid", newId?: string) => {
  const tbl = await harnessTable("messages");
  const rows = await rawRows(tbl, `public_id = '${publicId}'`);
  if (rows.length !== 1) throw new Error(`expected 1 message, found ${rows.length}`);
  const source = rows[0] as Record<string, unknown>;
  if (mode === "delete") {
    await tbl.delete(`public_id = '${publicId}'`);
    return;
  }
  const copy: Record<string, unknown> = { ...source };
  if (mode === "reid") {
    // Same public_id and same ordinal, DIFFERENT legacy id: the identity a
    // public_id+seq comparison alone cannot see.
    await tbl.delete(`public_id = '${publicId}'`);
    copy.id = BigInt(newId ?? "999999");
  }
  const columns: Record<string, unknown[]> = {};
  for (const key of Object.keys(copy)) columns[key] = [copy[key]];
  await tbl.add(tableFromArrays(columns as never) as never);
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

/**
 * The clock is OPERATOR configuration, so the child supplies it the same way a
 * deployment would. `"throw"` proves a path never samples it at all: a replay
 * or a conflict that quietly took a reading would fail loudly here.
 */
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

const open = payload.factory === "evidence" ? openEvidenceWriter : openContextWriter;
const service = await open(datasetRoot!, {
  newRevisionId: () => "unusedrevision000000",
  clock,
  sourceNamespace: null,
  onContextBoundary: async (boundary: string) => {
    trace.push(boundary);
    const seen = (counts.get(boundary) ?? 0) + 1;
    counts.set(boundary, seen);
    if (payload.failAt && payload.failAt.boundary === boundary && payload.failAt.occurrence === seen) {
      throw new Error("commanded context hook failure");
    }
    const m = payload.mutateAt;
    if (m && m.boundary === boundary && m.occurrence === seen) {
      await reshapeMessage(m.public_id, m.kind as "delete" | "duplicate" | "reid", m.new_id);
    }
  },
});

const harness: Record<string, (request: any) => Promise<unknown>> = {
  /** Plant a retained row whose POINTER is null and whose timestamp is real. */
  async insertRawCursor(request) {
    const tbl = await harnessTable("read_cursors");
    await tbl.add(
      tableFromArrays({
        workspace_name: [request.workspace_name],
        peer_name: [request.peer_name],
        session_name: [request.session_name],
        last_read_message_id: [request.last_read_message_id ?? null],
        last_read_at: [BigInt(request.last_read_at_micros)],
      } as never) as never,
    );
    return { planted: true };
  },
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
  /** Rewrite the selected workspace row's physical state, losslessly. */
  async corruptWorkspace(request) {
    const tbl = await harnessTable("workspaces");
    const rows = await rawRows(tbl, `name = '${request.name}'`);
    if (rows.length !== 1) throw new Error(`expected 1 workspace, found ${rows.length}`);
    const copy: Record<string, unknown> = { ...(rows[0] as Record<string, unknown>) };
    await tbl.delete(`name = '${request.name}'`);
    if (request.created_at_micros !== undefined) copy.created_at = BigInt(request.created_at_micros);
    const columns: Record<string, unknown[]> = {};
    for (const key of Object.keys(copy)) columns[key] = [copy[key]];
    await tbl.add(tableFromArrays(columns as never) as never);
    return { corrupted: request.name };
  },
  async tableVersion(request) {
    return { version: String(await (await harnessTable(request.table)).version()) };
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
  results.contextHasClose = "close" in service.context;
  results.trace = trace;
  results.clockCalls = clockCalls;
}

// Evidence is printed BEFORE release so a close failure still leaves the
// parent something to read -- but the close itself is NOT swallowed. Poison
// must still permit release, so a child that could not release must never
// look successful: the rejection propagates and the exit status is nonzero.
console.log(JSON.stringify(results));
await service.close();
