/**
 * The owned fault-test child for taxonomy recovery (#50).
 *
 * Launched through `writer_gate.exec_with_gate`, so by the time this runs the
 * Python launcher has been replaced in place and THIS process is the single
 * gated owner. The parent kills it by that exact pid.
 *
 * It speaks one line of JSON per event on stdout, written straight to fd 1 so
 * a handshake is never stranded in a buffer while the parent waits:
 *
 *   {"event":"ready"}
 *   {"event":"boundary","name":<boundary>,"n":<1-based occurrence of that name>}
 *   {"event":"parked","name":...,"n":...}     // arrived and going no further
 *   {"event":"pre_emit","step":i}             // service returned, ACK unsent
 *   {"event":"step_result","step":i,"ok":...} // the ACK
 *   {"event":"post_emit","step":i}
 *   {"event":"done"}
 *
 * Every boundary is emitted, not just the commanded one: the complete trace is
 * itself evidence, and a child that only reported the boundary it stopped at
 * could not prove the other eight fired in the right order.
 *
 * Parking is either terminal (the parent SIGKILLs) or released by a line on
 * stdin. Reading stdin blocks in the kernel until the parent writes, so
 * nothing here sleeps or polls for permission to continue. (A FIFO was tried
 * first and deadlocked under Bun; stdin is the mechanism the #26 harness
 * already proved.)
 *
 * argv: <plan.json>
 */

// This file is a module: its only import is dynamic, and top-level await
// needs module scope to be legal.
export {};

const plan = JSON.parse(await Bun.file(process.argv[2]!).text());

const emit = async (event: Record<string, unknown>): Promise<void> => {
  await Bun.write(Bun.stdout, `${JSON.stringify(event)}\n`);
};

/** Park until killed. The parent owns the deadline, the signal and the reap. */
const parkForever = (): Promise<never> => new Promise<never>(() => {});

/**
 * Park until the parent writes a line on stdin. Blocks, never polls.
 *
 * ONE reader for the whole process, created on first use: a run can be
 * released more than once — locked, released, repaired, released again — and
 * re-acquiring `Bun.stdin.stream()` per park would either fail on an already
 * locked stream or drop whatever the parent had queued.
 */
const stdin: { reader: ReadableStreamDefaultReader<Uint8Array> | null } = { reader: null };
const parkUntilReleased = async (): Promise<void> => {
  const reader = (stdin.reader ??= Bun.stdin.stream().getReader());
  for (;;) {
    const { done, value } = await reader.read();
    // A closed stdin is also a release: the parent has nothing more to say,
    // and hanging here would turn its deadline into the only way out.
    if (done) return;
    if (value !== undefined && value.length > 0) return;
  }
};

const { openKnowledgeWriter } = await import(plan.serviceModule);

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

const onTaxonomyBoundary = async (name: string): Promise<void> => {
  counts[name] = (counts[name] ?? 0) + 1;
  const n = counts[name]!;
  await emit({ event: "boundary", name, n, step });
  if (step !== (plan.parkStep ?? 0)) return;
  if (matches(plan.throwAt, name, n)) {
    // A thrown hook is its own test, kept separate from a real SDK failure.
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

const service = await openKnowledgeWriter(plan.datasetRoot, {
  clock,
  newRevisionId,
  onTaxonomyBoundary,
});

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const call = async (spec: any): Promise<unknown> => {
  const facade = spec.facade === "publication" ? service.publication : service.taxonomy;
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
      failure =
        typeof error?.toJSON === "function"
          ? error.toJSON()
          : { version: null, code: null, path: null, message: String(error?.message ?? error) };
    }

    // The response-emission boundaries belong here, after the service has
    // returned: the write is durable and only the ACK is in flight.
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
    // Parking HERE, with the result already reported, is what lets the parent
    // change the world between two requests on the SAME owner and know
    // exactly when it did so.
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
    // from durable state, not something to hide or to re-throw over the result.
  }
  // Let go of stdin. An outstanding reader keeps this process alive, which
  // would turn a finished child into one the parent has to kill -- and a
  // killed child cannot report the exit code its result is judged by.
  try {
    await stdin.reader?.cancel();
  } catch {
    /* already gone */
  }
}
