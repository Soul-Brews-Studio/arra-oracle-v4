/**
 * The owned fault-test child for search-chunk recovery (#30 lanes).
 *
 * Same generic protocol as `read-cursor-v1/recovery/cursor-child.ts` and
 * `trace-v1/recovery/trace-child.ts`: one gated process, one line of JSON per
 * event on stdout. `indexRevisionChunks` fires exactly ONE
 * before_write/after_write/after_readback triple per call regardless of chunk
 * count (`service.ts`: one `writer.append` call for every missing row, one
 * readback loop after it) -- unlike `createTrace`'s per-row triples.
 *
 *   {"event":"ready"}
 *   {"event":"boundary","name":<boundary>,"n":<occurrence>,"step":i}
 *   {"event":"parked","name":...,"n":...}
 *   {"event":"pre_emit","step":i}
 *   {"event":"step_result","step":i,"ok":...}
 *   {"event":"post_emit","step":i}
 *   {"event":"fetch_calls","count":N}          // reported once, at "done"
 *   {"event":"done"}
 *
 * NETWORK GUARD: `globalThis.fetch` is replaced, in this process, before the
 * writer is even opened, with a function that records the call and then
 * THROWS -- the mcp-correctness.test.ts fail-if-used pattern. Every chunk-write
 * step in the plan therefore either never touches `fetch` (the contract's
 * claim) or fails LOUDLY as a step result naming that fault, never silently.
 *
 * INSTRUMENTED INTERLEAVE (test-only, authorized for this lane): the boundary
 * hook can open a RAW SDK connection to this run's own disposable dataset
 * root, inside this process, and plant a fault between the write and its
 * readback -- no second writer, no gate bypass, no product adapter.
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
    if (done) return;
    if (value !== undefined && value.length > 0) return;
  }
};

// Installed BEFORE the writer is opened: no window where an early network
// call could slip through unrecorded.
let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  fetchCalls += 1;
  throw new Error(`fetch must never be called on the chunk-write path (saw ${JSON.stringify(args[0])})`);
}) as unknown as typeof fetch;

const { openContextWriter } = await import(plan.serviceModule);
const { connect } = await import("@lancedb/lancedb");

const injectFault = async (injection: any): Promise<void> => {
  const db = await connect(plan.datasetRoot, { readConsistencyInterval: 0 });
  const table = await db.openTable("search_chunks_v1");
  await table.checkoutLatest();
  if (injection.kind === "duplicate_chunk") {
    // The exact row the harness authored, appended a second time: the
    // scoped readback in `indexRevisionChunks` (workspace + id) will see two
    // rows at one identity and refuse via `contextOne`'s own >1 rule --
    // integrity_failure, decided before any field comparison.
    await table.add([injection.row]);
    return;
  }
  if (injection.kind === "unexpected_text") {
    // Structurally VALID, simply not the text this call wrote: the readback
    // field comparison in `indexRevisionChunks` disagrees and poisons with
    // recovery_required, never integrity_failure -- the other §5 class.
    // `update`'s values map takes a SQL EXPRESSION per column, not a bare JS
    // value -- an unquoted string parses as an identifier and refuses, so
    // the text is quoted as a SQL string literal here.
    const literal = `'${String(injection.text).replace(/'/g, "''")}'`;
    await table.update({ text: literal }, { where: injection.where });
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
  await emit({ event: "fetch_calls", count: fetchCalls });
  await emit({ event: "done" });
} finally {
  globalThis.fetch = originalFetch;
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
