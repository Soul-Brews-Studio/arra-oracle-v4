// #28 trace ownership child — one gated program, selected by mode.
//
// Adapted from `read-cursor-v1/ownership/cursor-child.ts`: same generic
// dispatch shape, generalised so "queue-poison" takes its SECOND direction's
// bypass-read as an explicit `read_method`/`read_request` pair rather than
// hardcoding `getReadCursor` — trace's queue-bypassing reads are `getTrace`
// and `listTraceHits`, chosen per test rather than fixed here.
//
// Runs inside a process that genuinely holds the writer gate, prints named
// EVENT lines and nothing else. The parent owns the deadline and kills this
// exact PID.
//
// Not an oracle: every expected key set, row, code, path and message lives in
// `trace-ownership.test.ts`, authored from `trace-v1.md`.

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
const workspace = (payload.workspace as string) ?? "alpha-workspace";

const say = (event: string) => console.log(`EVENT ${event}`);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

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

const parked = deferred();
const resume = deferred();
let heldOnce = false;
const boundaryHook = async (boundary: string) => {
  say(`boundary ${boundary}`);
  if (boundary === payload.throw_at) throw new Error("commanded trace boundary failure");
  if (boundary !== payload.park_at || heldOnce) return;
  heldOnce = true;
  say("trace:parked");
  parked.resolve();
  await resume.promise;
};

const options = (extra: Json = {}) => ({
  newRevisionId: () => "r".repeat(21),
  clock:
    payload.clock_must_not_be_called === true
      ? () => {
          say("clock:called");
          throw new Error("clock sampled on a path that must not sample it");
        }
      : () => Number(payload.clock_ms ?? 1_789_905_600_000),
  sourceNamespace: payload.source_namespace ?? null,
  ...(payload.park_at === undefined && payload.throw_at === undefined
    ? {}
    : { onContextBoundary: boundaryHook }),
  ...extra,
});

const openWriter = (which: string) =>
  which === "evidence"
    ? service.openEvidenceWriter(root!, options())
    : service.openContextWriter(root!, options());

const contextOf = (bundle: WriterBundle | ReaderBundle): Facade => bundle.context as Facade;

if (mode === "writer-surface") {
  const which = (payload.factory as string) ?? "context";
  const bundle = await openWriter(which);
  say(`writer:${which}:keys ${Object.keys(bundle).sort().join(",")}`);
  say(`writer:${which}:context ${Object.keys(contextOf(bundle)).sort().join(",")}`);
  const values = [...new Set(Object.values(contextOf(bundle)).map((v) => typeof v))].sort();
  say(`writer:${which}:valuetypes ${values.join(",")}`);
  say(`writer:${which}:exports ${Object.keys(service as unknown as Json).sort().join(",")}`);
  await bundle.close();
}

if (mode === "reader-surfaces") {
  for (const which of ["context", "evidence"] as const) {
    const reader = which === "context" ? await service.openContextReader(root!) : await service.openEvidenceReader(root!);
    say(`reader:${which}:keys ${Object.keys(reader).sort().join(",")}`);
    say(`reader:${which}:context ${Object.keys(contextOf(reader)).sort().join(",")}`);
  }
}

if (mode === "setup") {
  const bundle = await openWriter("context");
  const context = contextOf(bundle);
  for (const [label, request] of Object.entries(payload.setup as Record<string, Json>)) {
    await report(
      `setup:${label}`,
      invoke(() => context[(payload.setup_methods as Record<string, string>)[label]!]!(encode(request))),
    );
  }
  await bundle.close();
}

if (mode === "ops") {
  const bundle = await openWriter((payload.factory as string) ?? "context");
  const context = contextOf(bundle);
  for (const step of payload.steps as { label: string; method: string; request: Json }[]) {
    await report(step.label, invoke(() => context[step.method]!(encode(step.request))));
  }
  await bundle.close();
}

if (mode === "reader-ops") {
  const which = (payload.factory as string) ?? "context";
  const reader = which === "context" ? await service.openContextReader(root!) : await service.openEvidenceReader(root!);
  const context = contextOf(reader);
  for (const step of payload.steps as { label: string; method: string; request: Json }[]) {
    await report(step.label, invoke(() => context[step.method]!(encode(step.request))));
  }
}

if (mode === "queue-poison") {
  const bundle = await openWriter("context");
  const context = contextOf(bundle);

  const first = invoke(() => context[payload.first_method as string]!(encode(payload.first_request)));
  await parked.promise;

  const second = invoke(() => context[payload.second_method as string]!(encode(payload.second_request)));
  void second.then(
    () => say("write:second-finished"),
    () => say("write:second-finished"),
  );

  // A queue-bypassing READ answers mid-write. Which method proves that is
  // chosen per test (`getTrace`/`listTraceHits`), never fixed here.
  await report(
    "parked:read",
    invoke(() => context[payload.read_method as string]!(encode(payload.read_request))),
  );

  say("write:first-resuming");
  resume.resolve();
  await report("write:first", first);
  await report("write:second", second);

  await report(
    "trace:write-after",
    invoke(() => context[payload.trace_after_method as string]!(encode(payload.trace_after_request))),
  );
  await report("context:write-after", invoke(() => context.registerPeer!(encode(payload.peer_request))));
  await report(
    "poisoned:read",
    invoke(() => context[payload.read_method as string]!(encode(payload.read_request))),
  );
  if (payload.peer_get_request !== undefined) {
    await report("poisoned:peer-get", invoke(() => context.getPeer!(encode(payload.peer_get_request))));
  }

  await bundle.close();
  await report("released:read", invoke(() => context[payload.read_method as string]!(encode(payload.read_request))));
  say("owner:alive");
  await new Promise((hold) => setTimeout(hold, Number(payload.hold_ms ?? 15_000)));
}

if (mode === "cross-factory") {
  const bundle = await openWriter("context");
  say("owner:context ready");
  const alias = payload.alias as string;
  const attempt = async (label: string, open: () => Promise<unknown>) =>
    say(`${label} ${await open().then(() => "ready", (error: unknown) => (error as { code?: string }).code ?? "no-code")}`);

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

say(`done ${workspace}`);
