/**
 * The owned fault-test child for #32 chat recovery.
 *
 * Styled directly on `test/fixtures/context-v1/recovery/context-child.ts`
 * (same event protocol, same launcher, same boundary-hook shape) with two
 * chat-specific additions:
 *
 *   1. A `globalThis.fetch` recorder installed BEFORE `service.ts` is ever
 *      imported, so any network attempt anywhere in this process -- not just
 *      inside `answerChat` -- is caught. It THROWS (fail-loud) rather than
 *      quietly recording, so a call that this file forgot to assert on still
 *      fails the run instead of passing silently.
 *   2. An in-process MODEL stub, selected by `plan.modelMode`
 *      ("stub" | "fail" | "absent"), counted in `modelCalls` and reported
 *      once as its own event -- never JSON-serialized as data, since it is
 *      code, exactly like the read-cursor and context children treat `clock`.
 *
 * Launched through `writer_gate.exec_with_gate`, so the Python launcher has
 * been replaced in place and THIS process is the single gated owner. The
 * parent kills it by that exact pid and measures its exit.
 *
 * One line of JSON per event on stdout:
 *
 *   {"event":"ready"}
 *   {"event":"boundary","name":<boundary>,"n":<occurrence>,"step":i}
 *   {"event":"parked","name":...,"n":...}
 *   {"event":"pre_emit"|"post_emit","step":i}
 *   {"event":"step_result","step":i,"ok":...,"modelCalls":<n>}
 *   {"event":"fetch_calls","n":<n>}   // emitted once, right before "done"
 *   {"event":"done"}
 *
 * argv: <plan.json>
 */

export {};

// Installed BEFORE any import of service.ts: if that module (or anything it
// pulls in) ever reaches the network, this call fails LOUD rather than
// silently succeeding against the real internet.
let fetchCalls = 0;
const originalFetch = globalThis.fetch;
// @ts-expect-error -- test-only global override, not a typed API.
globalThis.fetch = (...args: unknown[]) => {
  fetchCalls += 1;
  throw new Error(`commanded: no fetch is permitted on the chat path, but fetch(${JSON.stringify(args[0])}) was called`);
};
void originalFetch; // never restored: this process is disposable and exits after one plan.

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

const { openContextWriter } = await import(plan.serviceModule);

let clockIndex = 0;
let idIndex = 0;
let step = -1;
const counts: Record<string, number> = {};
let modelCalls = 0;

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

/**
 * The injected model boundary. `plan.modelMode` decides its behaviour:
 *   - "stub": returns a deterministic answer, never touching fetch.
 *   - "fail": throws, so `answerChat` must map it through `mapModelFailure`.
 *   - "absent" / unset: no `model` option is passed at all, so `answerChat`
 *     is unavailable on first use -- the boundary this file must prove is
 *     STUBBED, not merely present.
 */
const model =
  plan.modelMode === "stub" || plan.modelMode === "fail"
    ? async (input: { question: string }) => {
        modelCalls += 1;
        if (plan.modelMode === "fail") throw new Error("commanded model failure");
        return `stub answer for: ${input.question}`;
      }
    : undefined;

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
  ...(model === undefined ? {} : { model }),
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
        ? { event: "step_result", step: i, ok: true, value: value ?? null, modelCalls }
        : { event: "step_result", step: i, ok: false, error: failure, modelCalls },
    );
    if (i === (plan.parkStep ?? 0) && plan.emitPark === "after_response_emission") {
      await emit({ event: "post_emit", step: i });
      if (plan.resumeOnStdin === true) await parkUntilReleased();
      else await parkForever();
    }
  }
  await emit({ event: "fetch_calls", n: fetchCalls });
  await emit({ event: "done" });
} finally {
  try {
    await service.close();
  } catch {
    /* a close that fails after the work is reported is the parent's to judge */
  }
  try {
    await stdin.reader?.cancel();
  } catch {
    /* already gone */
  }
}
