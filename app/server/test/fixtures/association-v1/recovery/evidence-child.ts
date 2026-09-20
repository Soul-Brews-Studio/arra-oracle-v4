/**
 * The owned fault-test child for association materialization recovery (#67).
 *
 * Launched through `writer_gate.exec_with_gate`, so the Python launcher has
 * been replaced in place and THIS process is the single gated owner. The
 * parent kills it by that exact pid and measures its exit.
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
 * Every boundary is reported, not only the commanded one. The contract freezes
 * a literal firing order — one delete triple per REPLACED table, row triples
 * per appended row, all term-table boundaries before any link-table boundary —
 * so the complete trace is itself the evidence.
 *
 * Parking is either terminal (the parent SIGKILLs) or released by a line on
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
    if (done) return; // parent closed stdin: also a release
    if (value !== undefined && value.length > 0) return;
  }
};

const { openEvidenceWriter } = await import(plan.serviceModule);

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

const onEvidenceBoundary = async (name: string): Promise<void> => {
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

const service = await openEvidenceWriter(plan.datasetRoot, {
  clock,
  newRevisionId,
  sourceNamespace: plan.sourceNamespace ?? null,
  onEvidenceBoundary,
});

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const facadeOf = (name: string): any =>
  name === "publication"
    ? service.publication
    : name === "taxonomy"
      ? service.taxonomy
      : name === "context"
        ? service.context
        : service.evidence;

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
      // The exact envelope plus the real class name, for assertions that must
      // distinguish two envelopes sharing a code.
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
    // Parking HERE, with the result reported, lets the parent change the world
    // between two requests on the SAME owner and know exactly when it did.
    if (i === (plan.parkStep ?? 0) && plan.emitPark === "after_response_emission") {
      await emit({ event: "post_emit", step: i });
      if (plan.resumeOnStdin === true) await parkUntilReleased();
      else await parkForever();
    }
  }
  await emit({ event: "done" });
} finally {
  // A failing close must reach the parent as a NONZERO exit. Swallowing it
  // would let a child report clean results and exit 0 while its owner never
  // released cleanly — precisely the ambiguity these tests exist to detect.
  // stdin is released in a nested finally so the close error still propagates.
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
