// #29 lifecycle ownership child — one gated program, selected by mode.
//
// Runs inside a process that genuinely holds the writer gate, prints named
// EVENT lines and nothing else. The parent owns the deadline and kills this
// exact PID. Adapted from the accepted
// `fixtures/read-cursor-v1/ownership/cursor-child.ts`: same dispatch shape,
// generalised to dispatch a step onto ANY facade (`publication` to seed
// nodes/revisions, `context` for retireNode/supersedeNode/listLifecycleHistory
// /getRecallEligibility) rather than one cursor-only facade.
//
// Not an oracle: every expected key set, row, code, path and message lives in
// `lifecycle-ownership.test.ts`.
//
// ONE writer per process. `close()` releases the inherited descriptor, so a
// second writer open here is refused for gate reasons.

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;

type Json = Record<string, unknown>;
type Facade = Record<string, (bytes: Uint8Array) => Promise<unknown>>;
type WriterBundle = Record<string, Facade | (() => Promise<void>)> & { close(): Promise<void> };
type ReaderBundle = Record<string, Facade>;

const service = (await import(servicePath)) as {
  openContextReader: (root: string) => Promise<ReaderBundle>;
  openContextWriter: (root: string, options: Json) => Promise<WriterBundle>;
  openEvidenceReader: (root: string) => Promise<ReaderBundle>;
  openEvidenceWriter: (root: string, options: Json) => Promise<WriterBundle>;
};

const [, , mode, root, payloadPath] = process.argv;
const payload: Json = payloadPath === undefined ? {} : JSON.parse(await Bun.file(payloadPath).text());

const say = (event: string) => console.log(`EVENT ${event}`);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Errors travel as a STRUCTURED object: the runtime name plus all four wire
 *  fields from `toJSON`. */
const shape = (error: unknown) => {
  const e = error as {
    name?: string;
    code?: string;
    path?: string;
    message?: string;
    toJSON?: () => { version?: string; code?: string; path?: string; message?: string };
  };
  const wire = typeof e.toJSON === "function" ? e.toJSON() : {};
  return {
    name: e.name ?? null,
    version: wire.version ?? null,
    code: wire.code ?? e.code ?? null,
    path: wire.path ?? e.path ?? null,
    message: wire.message ?? e.message ?? null,
  };
};

/** A request refused by static grammar throws synchronously, before any
 *  promise exists. Wrapping the call keeps that failure inside the same
 *  reporting path as a rejected promise. */
const invoke = (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    return action();
  } catch (error) {
    return Promise.reject(error);
  }
};

const report = (label: string, promise: Promise<unknown>) =>
  promise.then(
    (value) => say(`json:${label} ${JSON.stringify({ ok: true, value })}`),
    (error: unknown) => say(`json:${label} ${JSON.stringify({ ok: false, error: shape(error) })}`),
  );

const deferred = () => {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolveDeferred) => {
    settle = resolveDeferred;
  });
  return { promise, resolve: () => settle?.() };
};

/** Park and throw are separate boundaries: a first pre-write hook refusal
 *  leaves the owner usable; a post-attempt failure poisons it. */
const parked = deferred();
const resume = deferred();
let heldOnce = false;
const boundaryHook = async (boundary: string) => {
  say(`boundary ${boundary}`);
  if (boundary === payload.throw_at) throw new Error("commanded lifecycle boundary failure");
  if (boundary !== payload.park_at || heldOnce) return;
  heldOnce = true;
  say("lifecycle:parked");
  parked.resolve();
  await resume.promise;
};

let revisionIndex = 0;
let clockIndex = 0;
const revisionIds = (payload.revision_ids as string[] | undefined) ?? [];
const clockMs = payload.clock_ms as number | number[] | undefined;

const options = (extra: Json = {}) => ({
  newRevisionId: () => revisionIds[revisionIndex++] ?? `fallbackrev${String(revisionIndex).padStart(9, "0")}`,
  clock: () => {
    if (Array.isArray(clockMs)) {
      const value = clockMs[Math.min(clockIndex, clockMs.length - 1)];
      clockIndex += 1;
      if (value === undefined) throw new Error("clock samples exhausted");
      return value;
    }
    return clockMs ?? 1_789_905_600_000;
  },
  sourceNamespace: payload.source_namespace ?? null,
  ...(payload.park_at === undefined && payload.throw_at === undefined
    ? {}
    : { onContextBoundary: boundaryHook }),
  ...extra,
});

const openWriter = (which: string) =>
  which === "evidence" ? service.openEvidenceWriter(root!, options()) : service.openContextWriter(root!, options());

const facadeOf = (bundle: WriterBundle | ReaderBundle, name: string): Facade => bundle[name] as Facade;

if (mode === "writer-surface") {
  const which = (payload.factory as string) ?? "context";
  const bundle = await openWriter(which);
  say(`writer:${which}:keys ${Object.keys(bundle).sort().join(",")}`);
  say(`writer:${which}:context ${Object.keys(facadeOf(bundle, "context")).sort().join(",")}`);
  const values = [...new Set(Object.values(facadeOf(bundle, "context")).map((v) => typeof v))].sort();
  say(`writer:${which}:valuetypes ${values.join(",")}`);
  say(`writer:${which}:exports ${Object.keys(service as unknown as Json).sort().join(",")}`);
  await bundle.close();
}

if (mode === "reader-surfaces") {
  for (const which of ["context", "evidence"] as const) {
    const reader =
      which === "context" ? await service.openContextReader(root!) : await service.openEvidenceReader(root!);
    say(`reader:${which}:keys ${Object.keys(reader).sort().join(",")}`);
    say(`reader:${which}:context ${Object.keys(facadeOf(reader, "context")).sort().join(",")}`);
  }
}

if (mode === "ops") {
  // A generic step runner: each step names its own facade, so publishRevision
  // (publication) can seed nodes/revisions in the SAME owner that then runs
  // retireNode/supersedeNode/listLifecycleHistory/getRecallEligibility
  // (context).
  const bundle = await openWriter((payload.factory as string) ?? "context");
  for (const step of payload.steps as { label: string; facade: string; method: string; request: Json }[]) {
    const facade = facadeOf(bundle, step.facade);
    await report(step.label, invoke(() => facade[step.method]!(encode(step.request))));
  }
  await bundle.close();
}

if (mode === "queue-poison") {
  // Both directions live on the SAME "context" facade object, because
  // retireNode/supersedeNode and registerPeer are both context-writer
  // methods sharing one queue — unlike read-cursor, there is no second
  // facade object to dispatch onto here.
  const bundle = await openWriter("context");
  const context = facadeOf(bundle, "context");

  const first = invoke(() =>
    context[(payload.first as Json).method as string]!(encode((payload.first as Json).request)),
  );
  await parked.promise;

  const second = invoke(() =>
    context[(payload.second as Json).method as string]!(encode((payload.second as Json).request)),
  );
  void second.then(
    () => say("write:second-finished"),
    () => say("write:second-finished"),
  );

  // Lifecycle/context reads bypass the write queue: this answers mid-write.
  await report("parked:get", invoke(() => context[(payload.get as Json).method as string]!(encode((payload.get as Json).request))));

  say("write:first-resuming");
  resume.resolve();
  await report("write:first", first);
  await report("write:second", second);

  await report(
    "lifecycle:write-after",
    invoke(() =>
      context[(payload.lifecycle_after as Json).method as string]!(encode((payload.lifecycle_after as Json).request)),
    ),
  );
  await report(
    "context:write-after",
    invoke(() => context.registerPeer!(encode(payload.peer_request))),
  );
  await report("poisoned:get", invoke(() => context[(payload.get as Json).method as string]!(encode((payload.get as Json).request))));
  if (payload.peer_get_request !== undefined) {
    await report("poisoned:peer-get", invoke(() => context.getPeer!(encode(payload.peer_get_request))));
  }
  if (payload.lifecycle_get_request !== undefined) {
    await report(
      "poisoned:lifecycle-get",
      invoke(() => context.listLifecycleHistory!(encode(payload.lifecycle_get_request))),
    );
  }

  await bundle.close();
  await report("released:get", invoke(() => context[(payload.get as Json).method as string]!(encode((payload.get as Json).request))));
  say("owner:alive");
  await new Promise((hold) => setTimeout(hold, Number(payload.hold_ms ?? 15_000)));
}

if (mode === "cross-factory") {
  const bundle = await openWriter("context");
  say("owner:context ready");
  const alias = payload.alias as string;
  const attempt = async (label: string, open: () => Promise<unknown>) =>
    say(
      `${label} ${await open().then(
        () => "ready",
        (error: unknown) => (error as { code?: string }).code ?? "no-code",
      )}`,
    );

  await attempt("second:context", () => service.openContextWriter(root!, options()));
  await attempt("second:evidence", () => service.openEvidenceWriter(root!, options()));
  await attempt("second:alias", () => service.openContextWriter(alias, options()));

  const closing = bundle.close();
  const closingAgain = bundle.close();
  say(`close:same-promise ${closing === closingAgain}`);
  await closing;
  say("close:resolved");
  await attempt("reopen:after-close", () => service.openContextWriter(root!, options()));
  say("owner:alive");
  await new Promise((hold) => setTimeout(hold, Number(payload.hold_ms ?? 15_000)));
}

say("done");
