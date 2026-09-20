// #49 ownership child — composition, exclusion, queue, poison and close.
//
// One gated program, selected by `mode`, so every case runs inside a process that
// genuinely holds the writer gate. It prints named EVENT lines and nothing else;
// the parent owns the deadline and kills this PID.
//
// Nothing here is an oracle. Expected surfaces, codes and orderings live in the
// parent test, authored from `taxonomy-write-v1.md` rather than read back from
// the code under test.

// Imported through computed paths: the kernel and the taxonomy helper land in
// other lanes, and a static import would turn "not built yet" into a project-wide
// typecheck failure instead of a loud runtime error here.
const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const helperPath = new URL("../../../helpers/taxonomy-fixture.ts", import.meta.url).pathname;
type Json = Record<string, unknown>;
type Facade = Record<string, (bytes: Uint8Array) => Promise<unknown>>;
type Bundle = { publication: Facade; taxonomy: Facade; close(): Promise<void> };
type HelperApi = {
  encodeRequest: (value: unknown) => Uint8Array;
  seedManifest: (workspace: string, ids?: Record<string, string>) => Json;
  termRequest: (workspace: string, overrides?: Json) => Json;
  vocabularyRequest: (workspace: string, overrides?: Json) => Json;
};

const { openKnowledgeReader, openKnowledgeWriter, openPublicationWriter } = (await import(servicePath)) as {
  openKnowledgeReader: (root: string) => Promise<{ publication: Facade; taxonomy: Facade }>;
  openKnowledgeWriter: (root: string, options: Json) => Promise<Bundle>;
  openPublicationWriter: (root: string, options: Json) => Promise<Facade & { close(): Promise<void> }>;
};
const { encodeRequest, seedManifest, vocabularyRequest } = (await import(helperPath)) as HelperApi;

const [, , mode, root, alias, payloadPath] = process.argv;
const FIXED_CLOCK_MS = 1_789_905_600_000;
const REVISION_ID = "r".repeat(21);

const say = (event: string) => console.log(`EVENT ${event}`);
const codeOf = (error: unknown) => (error as { code?: string }).code ?? "no-code";
const settle = (promise: Promise<unknown>, label: string) =>
  promise.then(
    (value) => `${label} ok ${JSON.stringify((value as { outcome?: string })?.outcome ?? null)}`,
    (error: unknown) => `${label} ${codeOf(error)}`,
  );

const payload = payloadPath === undefined ? {} : JSON.parse(await Bun.file(payloadPath).text());
const workspace: string = payload.workspace ?? "alpha-workspace";
const seedIds = payload.seed_ids ?? {};

type Hook = (boundary: string) => Promise<void>;
const writerOptions = (hooks: { onTaxonomyBoundary?: Hook; onBoundary?: Hook } = {}) => ({
  newRevisionId: () => REVISION_ID,
  clock: () => FIXED_CLOCK_MS,
  ...hooks,
});

/** Deferred, so the parent learns about a park from the event, not from timing. */
const deferred = () => {
  let settleFn: (() => void) | undefined;
  const promise = new Promise<void>((resolveDeferred) => {
    settleFn = resolveDeferred;
  });
  return { promise, resolve: () => settleFn?.() };
};

const seedRequest = () => encodeRequest(seedManifest(workspace, seedIds));

if (mode === "surfaces") {
  const bundle = await openKnowledgeWriter(root!, writerOptions());
  say(`bundle:keys ${Object.keys(bundle).sort().join(",")}`);
  say(`bundle:publication ${Object.keys(bundle.publication).sort().join(",")}`);
  say(`bundle:taxonomy ${Object.keys(bundle.taxonomy).sort().join(",")}`);
  const values = [...new Set(Object.values(bundle.taxonomy).map((v) => typeof v))].sort();
  say(`bundle:valuetypes ${values.join(",")}`);
  say(`bundle:prototype ${Object.getPrototypeOf(bundle.taxonomy) === Object.prototype}`);
  await bundle.close();

  // A reader needs no gate; it is opened here only to keep one child per mode.
  const reader = await openKnowledgeReader(root!);
  say(`reader:keys ${Object.keys(reader).sort().join(",")}`);
  say(`reader:publication ${Object.keys(reader.publication).sort().join(",")}`);
  say(`reader:taxonomy ${Object.keys(reader.taxonomy).sort().join(",")}`);
}

if (mode === "bundle-first") {
  const bundle = await openKnowledgeWriter(root!, writerOptions());
  say("owner:bundle ready");
  say(`second:publication ${await openPublicationWriter(root!, writerOptions()).then(() => "ready", codeOf)}`);
  say(`second:bundle ${await openKnowledgeWriter(root!, writerOptions()).then(() => "ready", codeOf)}`);
  say(`second:alias ${await openKnowledgeWriter(alias!, writerOptions()).then(() => "ready", codeOf)}`);
  say(`second:alias-publication ${await openPublicationWriter(alias!, writerOptions()).then(() => "ready", codeOf)}`);
  await bundle.close();
}

if (mode === "publication-first") {
  const publication = await openPublicationWriter(root!, writerOptions());
  say("owner:publication ready");
  say(`second:bundle ${await openKnowledgeWriter(root!, writerOptions()).then(() => "ready", codeOf)}`);
  say(`second:alias-bundle ${await openKnowledgeWriter(alias!, writerOptions()).then(() => "ready", codeOf)}`);
  await publication.close();
}

if (mode === "queue-order") {
  // Park the FIRST taxonomy write inside the queue, then prove that a second
  // write waits while reads keep answering.
  const parked = deferred();
  const resume = deferred();
  let held = false;
  const bundle = await openKnowledgeWriter(
    root!,
    writerOptions({
      onTaxonomyBoundary: async (boundary) => {
        if (boundary !== "before_write" || held) return;
        held = true;
        say("taxonomy:parked");
        parked.resolve();
        await resume.promise;
      },
    }),
  );

  const first = bundle.taxonomy.seedReservedVocabularies(seedRequest());
  await parked.promise;

  const second = bundle.taxonomy.createVocabulary(
    encodeRequest(vocabularyRequest(workspace, payload.second_vocabulary ?? {})),
  );
  second.then(() => say("write:second-finished")).catch(() => say("write:second-finished"));

  // Reads are off the write queue, so both of these must answer while the write
  // above is parked mid-operation.
  const readTerm = await bundle.taxonomy
    .getTerm(encodeRequest({ workspace_name: workspace, term_id: seedIds.note }))
    .then((row) => (row === null ? "null" : "row"), codeOf);
  say(`read:taxonomy-while-parked ${readTerm}`);
  const readHead = await bundle.publication
    .getAcceptedHead(encodeRequest({ workspace_name: workspace, node_id: "n".repeat(21) }))
    .then((row) => (row === null ? "null" : "row"), codeOf);
  say(`read:publication-while-parked ${readHead}`);

  say("write:first-resuming");
  resume.resolve();
  say(await settle(first, "write:first"));
  say(await settle(second, "write:second"));
  await bundle.close();
}

if (mode === "poison-taxonomy") {
  // Fail AFTER a row was really attempted, which is what must poison the owner.
  const bundle = await openKnowledgeWriter(
    root!,
    writerOptions({
      onTaxonomyBoundary: async (boundary) => {
        if (boundary === "after_term_write") throw new Error("commanded taxonomy boundary failure");
      },
    }),
  );
  say(await settle(bundle.taxonomy.seedReservedVocabularies(seedRequest()), "taxonomy:seed"));
  say(
    await settle(
      bundle.taxonomy.createVocabulary(encodeRequest(vocabularyRequest(workspace))),
      "taxonomy:after-poison",
    ),
  );
  say(
    await settle(
      bundle.publication.publishRevision(encodeRequest(payload.publish_request ?? {})),
      "publication:after-poison",
    ),
  );
  const read = await bundle.taxonomy
    .getVocabulary(encodeRequest({ workspace_name: workspace, vocabulary_id: seedIds.typeVocabulary }))
    .then((row) => (row === null ? "null" : "row"), codeOf);
  say(`read:after-poison ${read}`);
  await bundle.close();
}

if (mode === "poison-publication") {
  // The mirror direction: a publication fail-stop must block later taxonomy writes.
  const bundle = await openKnowledgeWriter(
    root!,
    writerOptions({
      onBoundary: async (boundary) => {
        if (boundary === "after_revision_append") throw new Error("commanded publication boundary failure");
      },
    }),
  );
  say(await settle(bundle.publication.publishRevision(encodeRequest(payload.publish_request ?? {})), "publication:publish"));
  say(
    await settle(
      bundle.taxonomy.createVocabulary(encodeRequest(vocabularyRequest(workspace))),
      "taxonomy:after-poison",
    ),
  );
  const read = await bundle.taxonomy
    .getVocabulary(encodeRequest({ workspace_name: workspace, vocabulary_id: seedIds.typeVocabulary }))
    .then((row) => (row === null ? "null" : "row"), codeOf);
  say(`read:after-poison ${read}`);
  await bundle.close();
}

if (mode === "close") {
  const parked = deferred();
  const resume = deferred();
  let held = false;
  const bundle = await openKnowledgeWriter(
    root!,
    writerOptions({
      onTaxonomyBoundary: async (boundary) => {
        if (boundary !== "before_write" || held) return;
        held = true;
        say("taxonomy:parked");
        parked.resolve();
        await resume.promise;
      },
    }),
  );

  const inFlight = bundle.taxonomy.seedReservedVocabularies(seedRequest());
  await parked.promise;
  const queued = bundle.taxonomy.createVocabulary(encodeRequest(vocabularyRequest(workspace)));
  say("close:called");
  const closing = bundle.close();
  // Calling close twice must return the SAME settled promise rather than closing
  // a descriptor number that may since have been reused.
  const closingAgain = bundle.close();
  say(`close:same-promise ${closing === closingAgain}`);
  resume.resolve();

  say(await settle(inFlight, "close:in-flight"));
  say(await settle(queued, "close:queued"));
  await closing;
  say("close:resolved");
  await closingAgain;
  say("close:second-resolved");

  const readAfterRelease = await bundle.taxonomy
    .getVocabulary(encodeRequest({ workspace_name: workspace, vocabulary_id: seedIds.typeVocabulary }))
    .then(() => "served", codeOf);
  say(`close:read-after-release ${readAfterRelease}`);
  // Deliberately still alive: the gate must already be free for another process.
  say("owner:alive");
  await new Promise((resolveHold) => setTimeout(resolveHold, Number(payload.hold_ms ?? 15_000)));
}

if (mode === "trace") {
  // Every hook call is reported, so the parent can assert the complete trace of a
  // fresh seed rather than only its totals.
  const bundle = await openKnowledgeWriter(
    root!,
    writerOptions({ onTaxonomyBoundary: async (boundary) => say(`boundary ${boundary}`) }),
  );
  say(await settle(bundle.taxonomy.seedReservedVocabularies(seedRequest()), "trace:seed"));
  // A replay of the same manifest is already satisfied and must emit NO further
  // mutation boundaries, which is what separates skipped rows from rewritten ones.
  say("trace:replay-start");
  say(await settle(bundle.taxonomy.seedReservedVocabularies(seedRequest()), "trace:replay"));
  await bundle.close();
}

say("done");
