// #66 ownership child — one gated program, selected by mode.
//
// Runs inside a process that genuinely holds the writer gate, prints named EVENT
// lines and nothing else. The parent owns the deadline and kills this exact PID.
//
// Not an oracle: every expected key set, code, path, envelope and row count lives
// in `association-ownership.test.ts`, authored from `association-evidence-v1.md`.
//
// ONE writer per process, deliberately. `close()` releases the inherited
// descriptor, so a second open in this process is refused — which is why each
// legacy factory gets its own child rather than sharing one.

// Computed-path imports, so a not-yet-built module is a loud runtime error here
// instead of a project-wide typecheck failure.
const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;

type Json = Record<string, unknown>;
type Facade = Record<string, (bytes: Uint8Array) => Promise<unknown>>;
type WriterBundle = {
  publication: Facade;
  taxonomy: Facade;
  context: Facade;
  evidence: Facade;
  close(): Promise<void>;
};
type ReaderBundle = { publication: Facade; taxonomy: Facade; context: Facade; evidence: Facade };

const service = (await import(servicePath)) as {
  openEvidenceReader: (root: string) => Promise<ReaderBundle>;
  openEvidenceWriter: (root: string, options: Json) => Promise<WriterBundle>;
  openContextWriter: (root: string, options: Json) => Promise<Json>;
  openKnowledgeWriter: (root: string, options: Json) => Promise<Json>;
  openPublicationWriter: (root: string, options: Json) => Promise<Json>;
};

const [, , mode, root, payloadPath] = process.argv;
const payload: Json = payloadPath === undefined ? {} : JSON.parse(await Bun.file(payloadPath).text());
const workspace = (payload.workspace as string) ?? "alpha-workspace";

const say = (event: string) => console.log(`EVENT ${event}`);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/**
 * Errors are emitted as a STRUCTURED object, never a rendered line: runtime
 * `name` plus all four wire fields from `toJSON`. A message containing quotes
 * cannot then be mistaken for an empty one, which is exactly what a tail check
 * got wrong. `toJSON` carries no name, so the name comes from the instance.
 */
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

/** Structured both ways: the parent compares closed objects, never rendered text. */
const jsonReport = (label: string, promise: Promise<unknown>) =>
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

const options = (extra: Json = {}) => ({
  newRevisionId: () => (payload.revision_id as string) ?? "r".repeat(21),
  clock: () => 1_789_905_600_000,
  sourceNamespace: payload.source_namespace ?? null,
  ...extra,
});

if (mode === "surfaces") {
  const writer = await service.openEvidenceWriter(root!, options());
  say(`writer:keys ${Object.keys(writer).sort().join(",")}`);
  for (const facade of ["publication", "taxonomy", "context", "evidence"] as const) {
    say(`writer:${facade} ${Object.keys(writer[facade]).sort().join(",")}`);
  }
  const values = [...new Set(Object.values(writer.evidence).map((v) => typeof v))].sort();
  say(`writer:evidence-valuetypes ${values.join(",")}`);
  say(`writer:evidence-prototype ${Object.getPrototypeOf(writer.evidence) === Object.prototype}`);
  say(`service:exports ${Object.keys(service as unknown as Json).sort().join(",")}`);
  await writer.close();

  const reader = await service.openEvidenceReader(root!);
  say(`reader:keys ${Object.keys(reader).sort().join(",")}`);
  for (const facade of ["publication", "taxonomy", "context", "evidence"] as const) {
    say(`reader:${facade} ${Object.keys(reader[facade]).sort().join(",")}`);
  }
}

if (mode === "legacy-one") {
  // ONE legacy factory per process: closing releases fd 42, so opening a second
  // here would be refused for a reason that has nothing to do with its shape.
  const which = payload.factory as "publication" | "knowledge" | "context";
  const open = {
    publication: () => service.openPublicationWriter(root!, options()),
    knowledge: () => service.openKnowledgeWriter(root!, options()),
    context: () => service.openContextWriter(root!, options()),
  }[which];
  const bundle = await open();
  say(`legacy:${which} ${Object.keys(bundle).sort().join(",")}`);
  for (const key of Object.keys(bundle).sort()) {
    const value = bundle[key];
    if (key !== "close" && typeof value === "object" && value !== null) {
      say(`legacy:${which}:${key} ${Object.keys(value as Json).sort().join(",")}`);
    }
  }
  await (bundle.close as () => Promise<void>)();
}

if (mode === "setup") {
  // A real accepted revision, so a later reconcile has something to materialize.
  const writer = await service.openEvidenceWriter(root!, options());
  await jsonReport("setup:seed", writer.taxonomy.seedReservedVocabularies!(encode(payload.seed_request)));
  await jsonReport("setup:publish", writer.publication.publishRevision!(encode(payload.publish_request)));
  await jsonReport("setup:head", writer.publication.getAcceptedHead!(encode(payload.head_request)));
  await writer.close();
}

if (mode === "queue-poison") {
  const parked = deferred();
  const resume = deferred();
  let held = false;
  const writer = await service.openEvidenceWriter(
    root!,
    options({
      onEvidenceBoundary: async (boundary: string) => {
        say(`boundary ${boundary}`);
        // Throwing at a REAL post-append boundary is what poisons; parking at
        // before_write only holds the queue.
        if (boundary === payload.throw_at) throw new Error("commanded evidence boundary failure");
        if (boundary !== (payload.park_at ?? "before_write") || held) return;
        held = true;
        say("evidence:parked");
        parked.resolve();
        await resume.promise;
      },
    }),
  );

  const first = writer.evidence.reconcileRevisionAssociations!(encode(payload.reconcile_request));
  await parked.promise;

  const second = writer.context.registerPeer!(encode(payload.peer_request));
  void second.then(
    () => say("write:second-finished"),
    () => say("write:second-finished"),
  );

  // Both evidence reads, while a write is parked mid-operation.
  await jsonReport("parked:get", writer.evidence.getRevisionAssociations!(encode(payload.read_request)));
  await jsonReport("parked:scan", writer.evidence.scanDependents!(encode(payload.scan_request)));

  say("write:first-resuming");
  resume.resolve();
  await jsonReport("write:first", first);
  await jsonReport("write:second", second);

  await jsonReport("evidence:write-after", writer.evidence.reconcileRevisionAssociations!(encode(payload.reconcile_request)));
  await jsonReport("context:write-after", writer.context.registerPeer!(encode(payload.peer_request)));
  // Both reads again, now on a poisoned owner.
  await jsonReport("poisoned:get", writer.evidence.getRevisionAssociations!(encode(payload.read_request)));
  await jsonReport("poisoned:scan", writer.evidence.scanDependents!(encode(payload.scan_request)));

  await writer.close();
  // …and after release, where both must fail.
  await jsonReport("released:get", writer.evidence.getRevisionAssociations!(encode(payload.read_request)));
  await jsonReport("released:scan", writer.evidence.scanDependents!(encode(payload.scan_request)));
  say("owner:alive");
  await new Promise((hold) => setTimeout(hold, Number(payload.hold_ms ?? 15_000)));
}

if (mode === "cross-factory") {
  const writer = await service.openEvidenceWriter(root!, options());
  say("owner:evidence ready");
  const alias = payload.alias as string;
  const attempt = async (label: string, open: () => Promise<unknown>) =>
    say(`${label} ${await open().then(() => "ready", (error: unknown) => (error as { code?: string }).code ?? "no-code")}`);

  await attempt("second:evidence", () => service.openEvidenceWriter(root!, options()));
  await attempt("second:evidence-alias", () => service.openEvidenceWriter(alias, options()));
  await attempt("second:context", () => service.openContextWriter(root!, options()));
  await attempt("second:knowledge", () => service.openKnowledgeWriter(root!, options()));
  await attempt("second:publication", () => service.openPublicationWriter(root!, options()));

  const closing = writer.close();
  const closingAgain = writer.close();
  say(`close:same-promise ${closing === closingAgain}`);
  await closing;
  say("close:resolved");
  await attempt("reopen:after-close", () => service.openEvidenceWriter(root!, options()));
  say("owner:alive");
  await new Promise((hold) => setTimeout(hold, Number(payload.hold_ms ?? 15_000)));
}

if (mode === "cursor") {
  const reader = await service.openEvidenceReader(root!);
  for (const [label, request] of Object.entries(payload.requests as Record<string, Json>)) {
    await jsonReport(label, reader.evidence.scanDependents!(encode(request)));
  }

  // The semantic boundary case needs the CURRENT version, which only a page can
  // report. The parent supplies every other cursor field, already bound.
  const base = payload.semantic_cursor as Json | undefined;
  if (base !== undefined) {
    const page = (await reader.evidence.scanDependents!(encode(payload.version_probe))) as {
      nodes_version?: string;
    };
    say(`semantic:version ${JSON.stringify(page.nodes_version ?? null)}`);
    const request = { ...(payload.semantic_request as Json), cursor: { ...base, nodes_version: page.nodes_version } };
    await jsonReport("semantic_boundary", reader.evidence.scanDependents!(encode(request)));
  }

  await jsonReport("read:absent-node", reader.evidence.getRevisionAssociations!(encode(payload.absent_read as Json)));
}

say(`done ${workspace}`);
