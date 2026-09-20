// #60 ownership child — one gated program, selected by mode.
//
// Every case runs inside a process that genuinely holds the writer gate, prints
// named EVENT lines and nothing else. The parent owns the deadline and kills
// this exact PID.
//
// Nothing here is an oracle: expected surfaces, codes, paths and orderings live
// in `context-ownership.test.ts`, authored from `context-ingestion-v1.md`.
//
// One writer instance per process, deliberately. `close()` releases the
// inherited descriptor, so a second open in the same process is refused — the
// parent therefore runs local and sourced namespaces as separate children.

// Computed-path imports: the context factories and the shared helper land in
// other lanes. A static import would turn "not built yet" into a project-wide
// typecheck failure instead of a loud runtime error here.
const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const helperPath = new URL("../../../helpers/context-fixture.ts", import.meta.url).pathname;

type Json = Record<string, unknown>;
type Facade = Record<string, (bytes: Uint8Array) => Promise<unknown>>;
type Bundle = { publication: Facade; taxonomy: Facade; context: Facade; close(): Promise<void> };

const { openContextReader, openContextWriter, openKnowledgeWriter, openPublicationWriter } = (await import(
  servicePath
)) as {
  openContextReader: (root: string) => Promise<{ publication: Facade; taxonomy: Facade; context: Facade }>;
  openContextWriter: (root: string, options: Json) => Promise<Bundle>;
  openKnowledgeWriter: (root: string, options: Json) => Promise<unknown>;
  openPublicationWriter: (root: string, options: Json) => Promise<unknown>;
};
const { encodeRequest } = (await import(helperPath)) as { encodeRequest: (value: unknown) => Uint8Array };

const [, , mode, root, payloadPath] = process.argv;
const payload: Json = JSON.parse(await Bun.file(payloadPath!).text());
const workspace = payload.workspace as string;
const FIXED_CLOCK_MS = 1_789_905_600_000;

const say = (event: string) => console.log(`EVENT ${event}`);
const shape = (error: unknown) => {
  const e = error as { name?: string; code?: string; path?: string; toJSON?: () => { version?: string } };
  // name AND version AND code AND path: the code alone is identical across
  // envelopes, which is exactly how an envelope defect survived two lanes.
  const version = typeof e.toJSON === "function" ? (e.toJSON().version ?? "no-version") : "no-version";
  return `${e.name ?? "no-name"} ${version} ${e.code ?? "no-code"} ${e.path === "" ? "(root)" : (e.path ?? "no-path")}`;
};
const report = (label: string, promise: Promise<unknown>) =>
  promise.then(
    (value) => {
      const v = value as { outcome?: string; reason?: string } | null;
      if (v === null) return say(`${label} null`);
      const reason = v.reason === undefined ? "" : `:${v.reason}`;
      // A read returns a row with no outcome field; say so rather than "no-outcome".
      say(`${label} ${v.outcome ?? "row"}${reason}`);
    },
    (error: unknown) => say(`${label} ${shape(error)}`),
  );

/** appendMessages returns a batch: print results AND stop, never just the outcome. */
const batchReport = (label: string, promise: Promise<unknown>) =>
  promise.then(
    (value) => {
      const v = value as { outcome: string; results: { index: number; outcome: string; row?: Json }[]; stop: Json | null };
      // Emit the STRUCTURE, not a rendered string: the parent decodes this and
      // compares the closed stop object exactly, never by substring.
      say(
        `batch-json:${label} ${JSON.stringify({
          outcome: v.outcome,
          results: v.results.map((r) => ({ index: r.index, outcome: r.outcome, public_id: (r.row as Json | undefined)?.public_id ?? null })),
          stop: v.stop,
        })}`,
      );
    },
    (error: unknown) => say(`batch-threw:${label} ${shape(error)}`),
  );

/** Deferred, so the parent learns about a park from an event rather than timing. */
const deferred = () => {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolveDeferred) => {
    settle = resolveDeferred;
  });
  return { promise, resolve: () => settle?.() };
};

const options = (extra: Json = {}) => ({
  newRevisionId: () => "r".repeat(21),
  clock: () => FIXED_CLOCK_MS,
  sourceNamespace: payload.source_namespace ?? null,
  ...extra,
});

const send = (facade: Facade, method: string, body: Json) => facade[method]!(encodeRequest(body));

if (mode === "surfaces") {
  const bundle = await openContextWriter(root!, options());
  say(`writer:keys ${Object.keys(bundle).sort().join(",")}`);
  say(`writer:publication ${Object.keys(bundle.publication).sort().join(",")}`);
  say(`writer:taxonomy ${Object.keys(bundle.taxonomy).sort().join(",")}`);
  say(`writer:context ${Object.keys(bundle.context).sort().join(",")}`);
  const values = [...new Set(Object.values(bundle.context).map((v) => typeof v))].sort();
  say(`writer:valuetypes ${values.join(",")}`);
  say(`writer:prototype ${Object.getPrototypeOf(bundle.context) === Object.prototype}`);
  await bundle.close();

  const reader = await openContextReader(root!);
  say(`reader:keys ${Object.keys(reader).sort().join(",")}`);
  say(`reader:publication ${Object.keys(reader.publication).sort().join(",")}`);
  say(`reader:taxonomy ${Object.keys(reader.taxonomy).sort().join(",")}`);
  say(`reader:context ${Object.keys(reader.context).sort().join(",")}`);
}

if (mode === "registration") {
  const bundle = await openContextWriter(root!, options());
  const context = bundle.context;
  const ids = payload.ids as Record<string, string>;
  const names = payload.names as Record<string, string>;

  await report("peer:new", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer }));
  // Same scoped ID and name: satisfied, never a second row and never a new clock.
  await report("peer:replay", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer }));
  // Same ID carrying a different name, and a different ID claiming the held name.
  await report("peer:same-id-new-name", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.other_peer }));
  await report("peer:new-id-held-name", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.spare_peer, name: names.peer }));
  await report("peer:absent-workspace", send(context, "registerPeer", { workspace_name: "no-such-workspace", peer_id: ids.spare_peer, name: names.other_peer }));

  await report("session:new", send(context, "registerSession", { workspace_name: workspace, session_id: ids.session, name: names.session }));
  await report("session:replay", send(context, "registerSession", { workspace_name: workspace, session_id: ids.session, name: names.session }));
  await report("session:new-id-held-name", send(context, "registerSession", { workspace_name: workspace, session_id: ids.spare_session, name: names.session }));

  await report("join:new", send(context, "joinSession", { workspace_name: workspace, session_name: names.session, peer_name: names.peer }));
  await report("join:replay", send(context, "joinSession", { workspace_name: workspace, session_name: names.session, peer_name: names.peer }));
  await report("join:absent-session", send(context, "joinSession", { workspace_name: workspace, session_name: "no-such-session", peer_name: names.peer }));
  await report("join:absent-peer", send(context, "joinSession", { workspace_name: workspace, session_name: names.session, peer_name: "no-such-peer" }));

  await bundle.close();
}

if (mode === "append") {
  // Registration plus one batch, so the parent can inspect ordering, replay and
  // reference rules against actual persisted rows.
  const bundle = await openContextWriter(root!, options());
  const context = bundle.context;
  const ids = payload.ids as Record<string, string>;
  const names = payload.names as Record<string, string>;

  await report("setup:peer", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer }));
  await report("setup:session", send(context, "registerSession", { workspace_name: workspace, session_id: ids.session, name: names.session }));
  await report("setup:join", send(context, "joinSession", { workspace_name: workspace, session_name: names.session, peer_name: names.peer }));

  for (const [label, request] of Object.entries(payload.batches as Record<string, Json>)) {
    await batchReport(label, send(context, "appendMessages", request));
  }

  await bundle.close();
}

if (mode === "collision-local") {
  // Two sessions, one public_id: the SECOND append names a stored row sitting in
  // another session, which §4 ranks above any immutable-state comparison.
  const bundle = await openContextWriter(root!, options());
  const context = bundle.context;
  const ids = payload.ids as Record<string, string>;
  const names = payload.names as Record<string, string>;

  await report("setup:peer", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer }));
  for (const [label, sessionId, sessionName] of [
    ["a", ids.session, names.session],
    ["b", ids.spare_session, names.other_session],
  ] as const) {
    await report(`setup:session-${label}`, send(context, "registerSession", { workspace_name: workspace, session_id: sessionId, name: sessionName }));
    await report(`setup:join-${label}`, send(context, "joinSession", { workspace_name: workspace, session_name: sessionName, peer_name: names.peer }));
  }

  for (const [label, request] of Object.entries(payload.batches as Record<string, Json>)) {
    await batchReport(label, send(context, "appendMessages", request));
  }
  await bundle.close();
}

if (mode === "collision-sourced") {
  // Sourced mode: the source tuple anchors the replay, never the proposed ID.
  const bundle = await openContextWriter(root!, options());
  const context = bundle.context;
  const ids = payload.ids as Record<string, string>;
  const names = payload.names as Record<string, string>;

  await report("setup:peer", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer }));
  // TWO sessions here as well, so a sourced replay can be aimed at the wrong one.
  for (const [label, sessionId, sessionName] of [
    ["a", ids.session, names.session],
    ["b", ids.spare_session, names.other_session],
  ] as const) {
    await report(`setup:session-${label}`, send(context, "registerSession", { workspace_name: workspace, session_id: sessionId, name: sessionName }));
    await report(`setup:join-${label}`, send(context, "joinSession", { workspace_name: workspace, session_name: sessionName, peer_name: names.peer }));
  }

  for (const [label, request] of Object.entries(payload.batches as Record<string, Json>)) {
    await batchReport(label, send(context, "appendMessages", request));
  }
  await bundle.close();
}

if (mode === "membership-setup") {
  // Registration plus one durable message, so history exists to read back after
  // the membership is later left or the session deactivated.
  const bundle = await openContextWriter(root!, options());
  const context = bundle.context;
  const ids = payload.ids as Record<string, string>;
  const names = payload.names as Record<string, string>;

  await report("setup:peer", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer }));
  await report("setup:session", send(context, "registerSession", { workspace_name: workspace, session_id: ids.session, name: names.session }));
  await report("setup:join", send(context, "joinSession", { workspace_name: workspace, session_name: names.session, peer_name: names.peer }));
  await batchReport("setup:append", send(context, "appendMessages", payload.seed_batch as Json));
  await bundle.close();
}

if (mode === "membership-after") {
  // The state the slice never creates itself: left membership, or an inactive
  // session. Writes must refuse; history must stay readable.
  const bundle = await openContextWriter(root!, options());
  const context = bundle.context;
  const names = payload.names as Record<string, string>;
  const ids = payload.ids as Record<string, string>;

  await report("after:join", send(context, "joinSession", { workspace_name: workspace, session_name: names.session, peer_name: names.peer }));
  await report("after:register-session", send(context, "registerSession", { workspace_name: workspace, session_id: ids.session, name: names.session }));
  await batchReport("after:append", send(context, "appendMessages", payload.append_request as Json));
  // Reads do not require active status; retired or left status never erases history.
  await report("after:get-session", send(context, "getSession", { workspace_name: workspace, session_name: names.session }));
  const page = await send(context, "listMessages", { workspace_name: workspace, session_name: names.session, after_seq: null, limit: 10 }).then(
    (value) => {
      const v = value as { rows: Json[]; next_after_seq: string | null };
      return `rows=${v.rows.length} next=${v.next_after_seq}`;
    },
    (error: unknown) => shape(error),
  );
  say(`after:list ${page}`);
  await bundle.close();
}

if (mode === "cross-factory") {
  // Explicit exclusion and close lifetime, not inferred from facade key sets.
  const bundle = await openContextWriter(root!, options());
  say("owner:context ready");
  const alias = payload.alias as string;
  const attempt = async (label: string, open: () => Promise<unknown>) =>
    say(`${label} ${await open().then(() => "ready", (error: unknown) => (error as { code?: string }).code ?? "no-code")}`);

  await attempt("second:context", () => openContextWriter(root!, options()));
  await attempt("second:context-alias", () => openContextWriter(alias, options()));
  await attempt("second:publication", () => openPublicationWriter(root!, options()));
  await attempt("second:knowledge", () => openKnowledgeWriter(root!, options()));
  await attempt("second:knowledge-alias", () => openKnowledgeWriter(alias, options()));

  const closing = bundle.close();
  const closingAgain = bundle.close();
  say(`close:same-promise ${closing === closingAgain}`);
  await closing;
  say("close:resolved");
  // Reopening in this process is refused: close released the descriptor, and §3
  // of the publication contract requires a held one before every open.
  await attempt("reopen:after-close", () => openContextWriter(root!, options()));
  say("owner:alive");
  await new Promise((resolveHold) => setTimeout(resolveHold, Number(payload.hold_ms ?? 15_000)));
}

if (mode === "read-history") {
  const reader = await openContextReader(root!);
  const context = reader.context;
  const names = payload.names as Record<string, string>;

  await report("read:peer", send(context, "getPeer", { workspace_name: workspace, peer_name: names.peer }));
  await report("read:absent-peer", send(context, "getPeer", { workspace_name: workspace, peer_name: "no-such-peer" }));
  await report("read:session", send(context, "getSession", { workspace_name: workspace, session_name: names.session }));
  await report("read:absent-workspace", send(context, "getSession", { workspace_name: "no-such-workspace", session_name: names.session }));
  await report("read:absent-message", send(context, "getMessage", { workspace_name: workspace, public_id: payload.absent_public_id as string }));
  await report("read:list-missing-session", send(context, "listMessages", { workspace_name: workspace, session_name: "no-such-session", after_seq: null, limit: 10 }));

  for (const [label, request] of Object.entries(payload.pages as Record<string, Json>)) {
    const page = await send(context, "listMessages", request).then(
      (value) => {
        const v = value as { rows: Record<string, unknown>[]; next_after_seq: string | null };
        return `rows=${v.rows.length} seqs=${v.rows.map((r) => r.seq_in_session).join("|")} next=${v.next_after_seq}`;
      },
      (error: unknown) => shape(error),
    );
    say(`page:${label} ${page}`);
  }
}

if (mode === "taxonomy-poison-first") {
  // Mirror direction: a TAXONOMY failure after an attempted write must stop
  // later context writes on the same owner.
  const bundle = await openContextWriter(
    root!,
    options({
      onTaxonomyBoundary: async (boundary: string) => {
        if (boundary === "after_term_write") throw new Error("commanded taxonomy boundary failure");
      },
    }),
  );
  const ids = payload.ids as Record<string, string>;
  const names = payload.names as Record<string, string>;
  await report("taxonomy:seed", bundle.taxonomy.seedReservedVocabularies!(encodeRequest(payload.seed_request as Json)));
  await report("context:write-after", send(bundle.context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer }));
  await report("context:read-after", send(bundle.context, "getPeer", { workspace_name: workspace, peer_name: names.peer }));
  await bundle.close();
}

if (mode === "queue-poison") {
  // One parked context write, then proof that another facade's write waits while
  // reads keep answering, and that a post-write failure poisons every facade.
  const parked = deferred();
  const resume = deferred();
  let held = false;
  const bundle = await openContextWriter(
    root!,
    options({
      onContextBoundary: async (boundary: string) => {
        say(`boundary ${boundary}`);
        // Throwing HERE, at the configured boundary, is what separates a
        // pre-write refusal from a post-attempt poisoning.
        if (boundary === payload.throw_at) throw new Error("commanded context boundary failure");
        if (boundary !== (payload.park_at ?? "before_write") || held) return;
        held = true;
        say("context:parked");
        parked.resolve();
        await resume.promise;
      },
    }),
  );
  const context = bundle.context;
  const ids = payload.ids as Record<string, string>;
  const names = payload.names as Record<string, string>;

  const first = send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer });
  await parked.promise;

  const second = send(context, "registerSession", { workspace_name: workspace, session_id: ids.session, name: names.session });
  void second.then(
    () => say("write:second-finished"),
    () => say("write:second-finished"),
  );

  // Reads are off the write queue and must answer while that write is parked.
  await report("read:while-parked", send(context, "getPeer", { workspace_name: workspace, peer_name: names.peer }));

  say("write:first-resuming");
  resume.resolve();
  await report("write:first", first);
  await report("write:second", second);

  // Both directions of the shared fail-stop, from whichever facade is poisoned.
  await report("taxonomy:after", bundle.taxonomy.getVocabulary!(encodeRequest({ workspace_name: workspace, vocabulary_id: ids.vocabulary })));
  await report("publication:after", bundle.publication.getAcceptedHead!(encodeRequest({ workspace_name: workspace, node_id: ids.node })));
  await report("context:write-after", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.spare_peer, name: names.other_peer }));
  // The other direction of the SAME owner: a taxonomy write must be stopped too.
  await report("taxonomy:write-after", bundle.taxonomy.createVocabulary!(encodeRequest(payload.vocabulary_request as Json)));

  await bundle.close();
  await report("read:after-release", send(context, "getPeer", { workspace_name: workspace, peer_name: names.peer }));
  say("owner:alive");
  await new Promise((resolveHold) => setTimeout(resolveHold, Number(payload.hold_ms ?? 15_000)));
}

say("done");
