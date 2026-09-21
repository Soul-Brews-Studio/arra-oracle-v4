// #29 lifecycle recovery child — one gated owner, streaming ONE JSON event per
// line so the parent can observe order (parked / result / done) rather than
// only a final blob. Adapted from the accepted core-lane
// `fixtures/lifecycle-v1/core/gated-lifecycle.ts` (same ops loop, same
// facade/harness dispatch, same onBoundary/onContextBoundary shape) plus the
// park/inject machinery from the accepted
// `fixtures/read-cursor-v1/recovery/cursor-child.ts` (same boundary-hook
// occurrence counting, same "instrumented raw-storage interleave inside the
// gated process that already holds the real writer gate" contract — no
// second writer, no gate bypass).
//
// Event protocol, one JSON object per stdout line:
//   {"event":"ready"}
//   {"event":"boundary","hook":"context"|"generic","name":<boundary>,"n":<occurrence>}
//   {"event":"parked","hook":...,"name":...,"n":...}      // real SIGKILL target
//   {"event":"injected","hook":...,"name":...,"n":...}
//   {"event":"result","index":i,"ok":true,"value":...} | {"event":"result","index":i,"ok":false,"error":{...}}
//   {"event":"clockCalls","n":...}
//   {"event":"done"}
//
// argv: <datasetRoot> <payloadJson>
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ facade: "context" | "publication" | "harness"; method: string; request: any }>;
  revisionIds?: string[];
  clockMs?: number | number[];
  contextParkAt?: { name: string; occurrence: number } | null;
  contextThrowAt?: { name: string; occurrence: number } | null;
  contextInjectAt?: { name: string; occurrence: number } | null;
  injection?: Record<string, unknown> | null;
  contextLockAt?: { name: string; occurrence: number; table: string } | null;
  genericParkAt?: { name: string; occurrence: number } | null;
  genericThrowAt?: { name: string; occurrence: number } | null;
};

const { openContextWriter } = await import(
  new URL("../../../../src/publication/service.ts", import.meta.url).pathname
);
const { rawRows } = await import(new URL("../../../../src/publication/storage.ts", import.meta.url).pathname);
const { connect } = await import("@lancedb/lancedb");
const { chmod } = await import("node:fs/promises");
const { join } = await import("node:path");

const emit = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify(event));
};

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

let clockCalls = 0;
let revisionIndex = 0;
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

const parkForever = (): Promise<never> => new Promise<never>(() => {});

/** Plant a SECOND row sharing (workspace_name, operation_id) with an already
 *  accepted event, so the write-in-flight's own readback (`contextOne` on
 *  that pair) finds two rows and throws the SAME integrity_failure class the
 *  product already raises for stored corruption — never a store mock. */
const injectDuplicateOperation = async (spec: Record<string, unknown>): Promise<void> => {
  const table = await harnessTable("supersede_log");
  await table.add([
    {
      id: BigInt(spec.id as string),
      workspace_name: spec.workspace_name,
      old_id: spec.old_id,
      old_revision_id: spec.old_revision_id,
      old_title: spec.old_title,
      old_type: spec.old_type,
      old_source: null,
      new_id: spec.new_id ?? null,
      new_revision_id: spec.new_revision_id ?? null,
      new_title: spec.new_title ?? null,
      new_source: null,
      reason: spec.reason,
      peer_name: spec.peer_name ?? null,
      superseded_at: new Date(Number(BigInt(spec.superseded_at_micros as string) / 1000n)),
      operation_id: spec.operation_id,
      h_metadata: null,
    },
  ]);
};

/** Plant a row with exactly one of new_id/new_revision_id null: the codec
 *  refuses to guess at supersede-vs-retire for that pair (lifecycle.ts:321),
 *  so any read that decodes it must throw integrity_failure. */
const injectHalfNullRow = async (spec: Record<string, unknown>): Promise<void> => {
  const table = await harnessTable("supersede_log");
  await table.add([
    {
      id: BigInt(spec.id as string),
      workspace_name: spec.workspace_name,
      old_id: spec.old_id,
      old_revision_id: spec.old_revision_id,
      old_title: spec.old_title,
      old_type: spec.old_type,
      old_source: null,
      new_id: (spec.new_id as string | null) ?? null,
      new_revision_id: (spec.new_revision_id as string | null) ?? null,
      new_title: null,
      new_source: null,
      reason: spec.reason,
      peer_name: null,
      superseded_at: new Date(Number(BigInt(spec.superseded_at_micros as string) / 1000n)),
      operation_id: spec.operation_id,
      h_metadata: null,
    },
  ]);
};

const contextCounts: Record<string, number> = {};
const onContextBoundary = async (name: string): Promise<void> => {
  const n = (contextCounts[name] = (contextCounts[name] ?? 0) + 1);
  emit({ event: "boundary", hook: "context", name, n });
  const inject = payload.contextInjectAt;
  if (inject !== undefined && inject !== null && inject.name === name && inject.occurrence === n) {
    await injectDuplicateOperation(payload.injection as Record<string, unknown>);
    emit({ event: "injected", hook: "context", name, n });
  }
  const lockAt = payload.contextLockAt as { name: string; occurrence: number; table: string } | null | undefined;
  if (lockAt !== undefined && lockAt !== null && lockAt.name === name && lockAt.occurrence === n) {
    // A REAL SDK failure, not a thrown hook: this boundary fires immediately
    // BEFORE the write's own SDK call, so the table is genuinely unwritable
    // by the time the product's own append runs.
    await chmod(join(datasetRoot!, `${lockAt.table}.lance`), 0o000);
    emit({ event: "locked", hook: "context", name, n });
  }
  const throwAt = payload.contextThrowAt;
  if (throwAt !== undefined && throwAt !== null && throwAt.name === name && throwAt.occurrence === n) {
    throw new Error("commanded context boundary failure");
  }
  const parkAt = payload.contextParkAt;
  if (parkAt !== undefined && parkAt !== null && parkAt.name === name && parkAt.occurrence === n) {
    emit({ event: "parked", hook: "context", name, n });
    await parkForever();
  }
};

const genericCounts: Record<string, number> = {};
const onBoundary = async (name: string): Promise<void> => {
  const n = (genericCounts[name] = (genericCounts[name] ?? 0) + 1);
  emit({ event: "boundary", hook: "generic", name, n });
  const throwAt = payload.genericThrowAt;
  if (throwAt !== undefined && throwAt !== null && throwAt.name === name && throwAt.occurrence === n) {
    throw new Error("commanded generic boundary failure");
  }
  const parkAt = payload.genericParkAt;
  if (parkAt !== undefined && parkAt !== null && parkAt.name === name && parkAt.occurrence === n) {
    emit({ event: "parked", hook: "generic", name, n });
    await parkForever();
  }
};

const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds?.[revisionIndex++] ?? `fallbackrev${String(revisionIndex).padStart(9, "0")}`,
  clock,
  sourceNamespace: null,
  onContextBoundary,
  onBoundary,
});

const harness: Record<string, (request: any) => Promise<unknown>> = {
  async readRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    return rows.map((r: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])),
    );
  },
  async injectHalfNullRow(request) {
    await injectHalfNullRow(request);
    return { injected: true };
  },
  async lockTable(request) {
    const dir = join(datasetRoot!, `${request.table}.lance`);
    await chmod(dir, 0o000);
    return { locked: dir };
  },
  async unlockTable(request) {
    const dir = join(datasetRoot!, `${request.table}.lance`);
    await chmod(dir, 0o700);
    return { unlocked: dir };
  },
};

emit({ event: "ready" });
for (const [index, op] of payload.ops.entries()) {
  let value: unknown;
  let failure: unknown = null;
  try {
    if (op.facade === "harness") {
      value = await harness[op.method]!(op.request);
    } else {
      const facade = (service as Record<string, Record<string, (b: Uint8Array) => Promise<unknown>>>)[op.facade];
      const call = facade?.[op.method];
      if (typeof call !== "function") throw new Error(`no such method: ${op.facade}.${op.method}`);
      value = await call(new TextEncoder().encode(JSON.stringify(op.request)));
    }
  } catch (error) {
    failure = describeError(error);
  }
  emit(
    failure === null
      ? { event: "result", index, ok: true, value: value ?? null }
      : { event: "result", index, ok: false, error: failure },
  );
}
emit({ event: "clockCalls", n: clockCalls });
emit({ event: "done" });
await service.close();
