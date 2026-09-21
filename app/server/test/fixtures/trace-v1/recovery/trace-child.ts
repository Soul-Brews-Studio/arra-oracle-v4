/**
 * The owned fault-test child for trace recovery (#28 lanes).
 *
 * Copied near-verbatim from `read-cursor-v1/recovery/cursor-child.ts`: that
 * file's protocol is already generic over facade/method, so trace needs no
 * cursor-specific change beyond this header. Launched through
 * `writer_gate.exec_with_gate`, so the Python launcher has been replaced in
 * place and THIS process is the single gated owner. The parent kills it by
 * that exact pid and measures its exit.
 *
 * One line of JSON per event on stdout, written straight to fd 1:
 *
 *   {"event":"ready"}
 *   {"event":"boundary","name":<boundary>,"n":<occurrence of that name>,"step":i}
 *   {"event":"parked","name":...,"n":...}      // arrived, going no further
 *   {"event":"pre_emit","step":i}              // call returned, ACK unsent
 *   {"event":"step_result","step":i,"ok":...}  // the ACK
 *   {"event":"post_emit","step":i}
 *   {"event":"done"}
 *
 * Every boundary is reported, not only the commanded one. `createTrace`
 * fires ONE before_write/after_write/after_readback triple per row it
 * appends (the trace row, then each hit, per `service.ts`'s `writeRow`) --
 * unlike the cursor kernel's fixed single triple per mutation, so callers of
 * this child must count triples rather than assume exactly one.
 *
 * Parking is either terminal (the parent SIGKILLs) or released by a line on
 * stdin, which blocks in the kernel rather than polling. One reader for the
 * whole process, because a run can be released more than once.
 *
 * INSTRUMENTED INTERLEAVE (test-only, authorized for this lane): when the plan
 * asks for it, the boundary hook opens a RAW SDK connection to this run's own
 * disposable dataset root -- inside THIS process, which already holds the real
 * writer gate -- and plants a fault between the service's write and its
 * readback. No second writer process, no gate bypass, no product adapter or
 * export is used or loaned. It is an instrumented raw-storage interleave and
 * proves what the service does when it finds such state at readback; it is NOT
 * a cooperative writer and NOT evidence about real SDK failures.
 *
 * argv: <plan.json>
 */

export {};

const plan = JSON.parse(await Bun.file(process.argv[2]!).text());

const emit = async (event: Record<string, unknown>): Promise<void> => {
  await Bun.write(Bun.stdout, `${JSON.stringify(event)}\n`);
};

const parkForever = (): Promise<never> => new Promise<never>(() => {});

const stdin: { reader: ReadableStreamDefaultReader<Uint8Array> | null } = { reader: null };
const parkUntilReleased = async (): Promise<void> => {
  const reader = (stdin.reader ??= Bun.stdin.stream().getReader());
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return; // parent closed stdin: also a release
    if (value !== undefined && value.length > 0) return;
  }
};

const { openContextWriter } = await import(plan.serviceModule);
const { connect } = await import("@lancedb/lancedb");

/**
 * Plant the requested fault through a raw connection, in this process.
 *
 * The row is built from values the TEST authored and passed in the plan,
 * never from a query of what the service just wrote.
 */
const injectFault = async (injection: any): Promise<void> => {
  const db = await connect(plan.datasetRoot, { readConsistencyInterval: 0 });
  if (injection.kind === "duplicate_trace") {
    const table = await db.openTable("traces");
    await table.checkoutLatest();
    await table.add([
      {
        id: injection.row.id,
        name: injection.row.name,
        workspace_name: injection.row.workspace_name,
        session_name: injection.row.session_name ?? null,
        peer_name: injection.row.peer_name ?? null,
        query: injection.row.query,
        mode: injection.row.mode ?? null,
        session_id: injection.row.session_id ?? null,
        session_from_ts: injection.row.session_from_ts_millis != null ? BigInt(injection.row.session_from_ts_millis) : null,
        session_to_ts: injection.row.session_to_ts_millis != null ? BigInt(injection.row.session_to_ts_millis) : null,
        friction_score: injection.row.friction_score ?? null,
        confidence: injection.row.confidence ?? null,
        parent_id: injection.row.parent_id ?? null,
        prev_id: injection.row.prev_id ?? null,
        depth: BigInt(injection.row.depth ?? 0),
        status: injection.row.status ?? "open",
        h_metadata: injection.row.h_metadata ?? null,
        internal_metadata: injection.row.internal_metadata ?? null,
        created_at: BigInt(injection.row.created_at_millis),
        updated_at: BigInt(injection.row.updated_at_millis),
      },
    ]);
    return;
  }
  if (injection.kind === "gap_hit") {
    const table = await db.openTable("trace_hits");
    await table.checkoutLatest();
    await table.add([
      {
        workspace_name: injection.row.workspace_name,
        trace_id: injection.row.trace_id,
        kind: injection.row.kind,
        ref: injection.row.ref,
        target: injection.row.target,
        line_start: injection.row.line_start ?? null,
        line_end: injection.row.line_end ?? null,
        excerpt: injection.row.excerpt ?? null,
        content_hash: injection.row.content_hash ?? null,
        captured_at: injection.row.captured_at_micros != null ? BigInt(injection.row.captured_at_micros) : null,
        note: injection.row.note ?? null,
        position: BigInt(injection.row.position),
      },
    ]);
    return;
  }
  throw new Error(`unknown injection: ${injection.kind}`);
};

let clockIndex = 0;
let idIndex = 0;
let step = -1;
const counts: Record<string, number> = {};

const clock = (): number => {
  const value = plan.clockMs[clockIndex];
  if (value === undefined) throw new Error("clock samples exhausted");
  clockIndex += 1;
  return value;
};

const newRevisionId = (): string => {
  const value = plan.revisionIds[idIndex];
  if (value === undefined) throw new Error("revision ids exhausted");
  idIndex += 1;
  return value;
};

const matches = (spec: { name: string; n: number } | null | undefined, name: string, n: number) =>
  spec !== null && spec !== undefined && spec.name === name && spec.n === n;

const onContextBoundary = async (name: string): Promise<void> => {
  counts[name] = (counts[name] ?? 0) + 1;
  const n = counts[name]!;
  await emit({ event: "boundary", name, n, step });
  if (step !== (plan.parkStep ?? 0)) return;
  if (matches(plan.throwAt, name, n)) {
    throw new Error(`commanded boundary failure at ${name}#${n}`);
  }
  if (matches(plan.injectAt, name, n)) {
    await injectFault(plan.injection);
    await emit({ event: "injected", name, n, step });
  }
  if (!matches(plan.parkAt, name, n)) return;
  await emit({ event: "parked", name, n, step });
  if (plan.resumeOnStdin === true) {
    await parkUntilReleased();
    return;
  }
  await parkForever();
};

const service = await openContextWriter(plan.datasetRoot, {
  clock,
  newRevisionId,
  sourceNamespace: plan.sourceNamespace ?? null,
  onContextBoundary,
});

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const facadeOf = (name: string): any =>
  name === "publication" ? service.publication : name === "taxonomy" ? service.taxonomy : service.context;

const call = async (spec: any): Promise<unknown> => {
  const facade = facadeOf(spec.facade);
  const method = facade?.[spec.method];
  if (typeof method !== "function") throw new Error(`no such method: ${spec.facade}.${spec.method}`);
  return await method.call(facade, encode(spec.request));
};

try {
  await emit({ event: "ready" });
  for (let i = 0; i < plan.steps.length; i++) {
    step = i;
    const spec = plan.steps[i];
    let value: unknown;
    let failure: unknown = null;
    try {
      value = await call(spec);
    } catch (error: any) {
      failure =
        typeof error?.toJSON === "function"
          ? { ...error.toJSON(), name: error.name }
          : { version: null, code: null, path: null, name: error?.name ?? null, message: String(error?.message ?? error) };
    }

    if (i === (plan.parkStep ?? 0) && plan.emitPark === "before_response_emission") {
      await emit({ event: "pre_emit", step: i });
      if (plan.resumeOnStdin === true) await parkUntilReleased();
      else await parkForever();
    }
    await emit(
      failure === null
        ? { event: "step_result", step: i, ok: true, value: value ?? null }
        : { event: "step_result", step: i, ok: false, error: failure },
    );
    if (i === (plan.parkStep ?? 0) && plan.emitPark === "after_response_emission") {
      await emit({ event: "post_emit", step: i });
      if (plan.resumeOnStdin === true) await parkUntilReleased();
      else await parkForever();
    }
  }
  await emit({ event: "done" });
} finally {
  try {
    await service.close();
  } finally {
    try {
      await stdin.reader?.cancel();
    } catch {
      /* already gone */
    }
  }
}
