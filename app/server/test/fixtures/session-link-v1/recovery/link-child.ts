/**
 * The owned fault-test child for session-link recovery (#28).
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
 *   {"event":"injected","name":...,"n":...}    // instrumented interleave fired
 *   {"event":"pre_emit","step":i}              // call returned, ACK unsent
 *   {"event":"step_result","step":i,"ok":...}  // the ACK
 *   {"event":"post_emit","step":i}
 *   {"event":"done","clockCalls":n}
 *
 * Every boundary is reported, not only the commanded one. The session-link
 * contract reuses the context boundary triple unchanged -- before_write,
 * after_write, after_readback, ONE triple per actual mutation, and silence for
 * replays, conflicts and reads -- so the complete trace is itself the evidence.
 *
 * `clockCalls` is reported for the same reason: decision 1 says a replay takes
 * NO clock sample, and a count of zero is direct evidence rather than an
 * inference from a timestamp that happens to match.
 *
 * Parking is either terminal (the parent SIGKILLs) or released by a line on
 * stdin, which blocks in the kernel rather than polling. One reader for the
 * whole process, because a run can be released more than once.
 *
 * INSTRUMENTED INTERLEAVE (test-only, authorized for this lane, adapted from
 * the accepted read-cursor recovery child): when the plan asks for it, the
 * boundary hook opens a RAW SDK connection to this run's own disposable
 * dataset root -- inside THIS process, which already holds the real writer
 * gate -- and plants a fault between the service's write and its readback. No
 * second writer process, no gate bypass, no product adapter or export is used
 * or loaned. It proves what the service does when it FINDS such state at
 * readback; it is NOT a cooperative writer and NOT evidence about real SDK
 * failures, which the chmod cases own.
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
 * The row is built from values the TEST authored and passed in the plan, never
 * from a query of what the service just wrote: a duplicate rebuilt out of the
 * product's own output would make the product its own oracle.
 */
const injectFault = async (injection: any): Promise<void> => {
  const db = await connect(plan.datasetRoot, { readConsistencyInterval: 0 });
  const table = await db.openTable("session_links");
  await table.checkoutLatest();
  if (injection.kind === "duplicate_session_link") {
    const micros = BigInt(injection.row.created_at_micros);
    if (micros % 1000n !== 0n) throw new Error("authored injection timestamp is not millisecond aligned");
    await table.add([
      {
        id: injection.row.id,
        workspace_name: injection.row.workspace_name,
        from_session_name: injection.row.from_session_name,
        to_session_name: injection.row.to_session_name,
        relation: injection.row.relation,
        evidence_ref: injection.row.evidence_ref,
        created_by_peer_name: injection.row.created_by_peer_name,
        // A Date, not a BigInt: the installed SDK refuses a BigInt for a
        // timestamp column, and exact milliseconds are what this authored
        // value carries.
        created_at: new Date(Number(micros / 1000n)),
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
    // A thrown hook is its own case, kept apart from a real SDK failure.
    throw new Error(`commanded boundary failure at ${name}#${n}`);
  }
  if (matches(plan.injectAt, name, n)) {
    // Between the service's write and its readback, in the same gated process.
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

/**
 * ONE call.
 *
 * `await` inside the try matters: `createSessionLink` refuses a self-link
 * SYNCHRONOUSLY, from the parser, before any promise exists, so a bare return
 * of the method's value would let that governed throw escape this frame.
 */
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
      // distinguish two envelopes sharing a code -- and, here, a governed
      // ContractError from a PublicationError carrying the same path.
      failure =
        typeof error?.toJSON === "function"
          ? { ...error.toJSON(), name: error.name }
          : {
              version: null,
              code: null,
              path: null,
              name: error?.name ?? null,
              message: String(error?.message ?? error),
            };
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
  await emit({ event: "done", clockCalls: clockIndex });
} finally {
  // A failing close must reach the parent as a NONZERO exit. Swallowing it
  // would let a child report clean results and exit 0 while its owner never
  // released cleanly -- precisely the ambiguity these tests exist to detect.
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
