/**
 * The owned fault-test child for context ingestion recovery (#61).
 *
 * Launched through `writer_gate.exec_with_gate`, so the Python launcher has
 * been replaced in place and THIS process is the single gated owner. The
 * parent kills it by that exact pid and measures its exit.
 *
 * One line of JSON per event on stdout, written straight to fd 1 so a
 * handshake is never stranded in a buffer:
 *
 *   {"event":"ready"}
 *   {"event":"boundary","name":<boundary>,"n":<occurrence of that name>,"step":i}
 *   {"event":"parked","name":...,"n":...}      // arrived, going no further
 *   {"event":"pre_emit","step":i}              // call returned, ACK unsent
 *   {"event":"step_result","step":i,"ok":...}  // the ACK
 *   {"event":"post_emit","step":i}
 *   {"event":"done"}
 *
 * Every boundary is reported, not only the commanded one: the trace is itself
 * evidence, and a child that spoke only where it stopped could not show that
 * the other rows fired in the right order.
 *
 * Parking is either terminal — the parent SIGKILLs — or released by a line on
 * stdin, which blocks in the kernel rather than polling. One reader for the
 * whole process, because a run can be released more than once.
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
    // A closed stdin is also a release: the parent has nothing more to say.
    if (done) return;
    if (value !== undefined && value.length > 0) return;
  }
};

const { openContextWriter } = await import(plan.serviceModule);

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
  // Context operations must never call this. If one does, the test sees the
  // failure here rather than a quietly consumed allocation.
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
    // A thrown hook is its own case, kept apart from a real SDK failure.
    throw new Error(`commanded boundary failure at ${name}#${n}`);
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

const call = async (spec: any): Promise<unknown> => {
  const facade = spec.facade === "publication" ? service.publication : spec.facade === "taxonomy" ? service.taxonomy : service.context;
  const method = facade[spec.method];
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
      // The exact envelope, when the error carries one. Anything else is
      // reported as raw text so an unexpected throw cannot pass for a code.
      failure =
        typeof error?.toJSON === "function"
          ? { ...error.toJSON(), name: error.name }
          : { version: null, code: null, path: null, name: error?.name ?? null, message: String(error?.message ?? error) };
    }

    // Response-emission parks belong here, after the call returned: the write
    // is durable and only the ACK is in flight.
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
  } catch {
    // A close that fails after the work is reported is the parent's to judge
    // from durable state, not something to hide behind the result.
  }
  // Let go of stdin: an outstanding reader keeps a finished child alive, and
  // a child the parent has to kill cannot report the exit code it is judged by.
  try {
    await stdin.reader?.cancel();
  } catch {
    /* already gone */
  }
}
