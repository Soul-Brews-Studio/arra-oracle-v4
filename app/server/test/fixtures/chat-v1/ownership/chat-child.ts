// #32 chat ownership child — one gated program, selected by mode.
//
// Styled on `test/fixtures/context-v1/ownership/context-child.ts`: every case
// runs inside a process that genuinely holds the writer gate, prints named
// EVENT lines and nothing else. The parent owns the deadline and kills this
// exact PID.
//
// Nothing here is an oracle: expected surfaces, codes and orderings live in
// `chat-ownership.test.ts`, authored independently from `service.ts` and
// `chat.ts` -- this child only drives the accepted factories.
//
// The MODEL is a real in-process function, never JSON-serialized (it is code,
// not data), so `answerChat` can be driven end to end without any network.
//
// #32 / R9: `answerChat` is no longer a writer method. It lives on the chat
// facade (`service.createChatService.ts`), built here over the SAME owner's
// context facade the queue/poison cases drive -- so "chat on a poisoned
// owner" is still exactly that owner's reads plus one model call.

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const chatServicePath = new URL("../../../../src/publication/service.createChatService.ts", import.meta.url).pathname;
const helperPath = new URL("../../../helpers/context-fixture.ts", import.meta.url).pathname;

type Json = Record<string, unknown>;
type Facade = Record<string, (bytes: Uint8Array) => Promise<unknown>>;
type Bundle = { publication: Facade; taxonomy: Facade; context: Facade; close(): Promise<void> };

const { openContextReader, openContextWriter, openEvidenceWriter } = (await import(servicePath)) as {
  openContextReader: (root: string) => Promise<{ publication: Facade; taxonomy: Facade; context: Facade }>;
  openContextWriter: (root: string, options: Json) => Promise<Bundle>;
  openEvidenceWriter: (root: string, options: Json) => Promise<unknown>;
};
const { encodeRequest } = (await import(helperPath)) as { encodeRequest: (value: unknown) => Uint8Array };
const { createChatService } = (await import(chatServicePath)) as {
  createChatService: (reader: Facade, options: Json) => Facade;
};

const [, , mode, root, payloadPath] = process.argv;
const payload: Json = JSON.parse(await Bun.file(payloadPath!).text());
const workspace = (payload.workspace as string) ?? "alpha-workspace";
const FIXED_CLOCK_MS = 1_789_905_600_000;

const say = (event: string) => console.log(`EVENT ${event}`);
const shape = (error: unknown) => {
  const e = error as { name?: string; code?: string; path?: string; toJSON?: () => { version?: string } };
  const version = typeof e.toJSON === "function" ? (e.toJSON().version ?? "no-version") : "no-version";
  return `${e.name ?? "no-name"} ${version} ${e.code ?? "no-code"} ${e.path === "" ? "(root)" : (e.path ?? "no-path")}`;
};
const report = (label: string, promise: Promise<unknown>) =>
  promise.then(
    (value) => say(`json:${label} ${JSON.stringify({ ok: true, value: value ?? null })}`),
    (error: unknown) => say(`json:${label} ${JSON.stringify({ ok: false, error: null })} ${shape(error)}`),
  );

/** Counted, never JSON-serialized: proving zero calls needs code, not data. */
let modelCalls = 0;
const stubModel = async (input: unknown) => {
  modelCalls++;
  if (payload.model_fail === true) throw new Error("commanded model failure");
  return `stub answer for ${(input as { question: string }).question}`;
};

const options = (extra: Json = {}) => ({
  newRevisionId: () => "r".repeat(21),
  clock: () => FIXED_CLOCK_MS,
  sourceNamespace: null,
  ...extra,
});
/** The chat facade over an owner's context reads, with the counted stub. */
const chatOver = (context: Facade) => createChatService(context, { model: stubModel, settings: null });

const send = (facade: Facade, method: string, body: Json) => facade[method]!(encodeRequest(body));

if (mode === "writer-surface") {
  const bundle = await openContextWriter(root!, options());
  say(`writer:keys ${Object.keys(bundle).sort().join(",")}`);
  say(`writer:context ${Object.keys(bundle.context).sort().join(",")}`);
  const values = [...new Set(Object.values(bundle.context).map((v) => typeof v))].sort();
  say(`writer:valuetypes ${values.join(",")}`);
  const service = await import(servicePath);
  say(`writer:exports ${Object.keys(service).sort().join(",")}`);
  await bundle.close();
}

if (mode === "reader-surface") {
  const reader = await openContextReader(root!);
  say(`reader:keys ${Object.keys(reader).sort().join(",")}`);
  say(`reader:context ${Object.keys(reader.context).sort().join(",")}`);
}

if (mode === "cross-factory") {
  const bundle = await openContextWriter(root!, options());
  say("owner:context ready");
  const attempt = async (label: string, open: () => Promise<unknown>) =>
    say(`${label} ${await open().then(() => "ready", (error: unknown) => (error as { code?: string }).code ?? "no-code")}`);

  await attempt("second:context", () => openContextWriter(root!, options()));
  await attempt("second:evidence", () => openEvidenceWriter(root!, options()));

  const closing = bundle.close();
  const closingAgain = bundle.close();
  say(`close:same-promise ${closing === closingAgain}`);
  await closing;
  say("close:resolved");
  await attempt("reopen:after-close", () => openContextWriter(root!, options()));
  say("owner:alive");
  await new Promise((resolveHold) => setTimeout(resolveHold, Number(payload.hold_ms ?? 15_000)));
}

if (mode === "chat-bypasses-poison") {
  // One poisoned ordinary context write (registerPeer, boundary "after_write"),
  // then proof that neither getContext nor answerChat needs recovery -- because
  // neither ever enters `core.serial`/the write queue -- while a LATER ordinary
  // write on the SAME owner is refused. `answerChat` itself is also proven to
  // never poison: a commanded model failure must not block the next write.
  //
  // One owner for the whole scenario (a second open in this process would be
  // refused once the first is closed -- `close()` releases the inherited gate
  // descriptor for the whole PROCESS, not just that handle). The hook is
  // armed only AFTER setup, via `armed`, so the four ordinary setup writes
  // cannot themselves trip the commanded failure.
  const ids = payload.ids as Record<string, string>;
  const names = payload.names as Record<string, string>;
  let armed = false;
  const bundle = await openContextWriter(
    root!,
    options({
      onContextBoundary: async (boundary: string) => {
        say(`boundary ${boundary}`);
        if (armed && boundary === (payload.throw_at ?? "after_write")) {
          throw new Error("commanded context boundary failure");
        }
      },
    }),
  );
  const context = bundle.context;

  await report("setup:session", send(context, "registerSession", { workspace_name: workspace, session_id: ids.session, name: names.session }));
  await report("setup:peer", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer }));
  await report("setup:join", send(context, "joinSession", { workspace_name: workspace, session_name: names.session, peer_name: names.peer }));
  await report(
    "setup:append",
    send(context, "appendMessages", {
      workspace_name: workspace,
      session_name: names.session,
      items: [{ public_id: ids.message, message: { peer_name: names.peer, role: null, content: "hello", in_reply_to: null }, source: null }],
    }),
  );

  armed = true;
  await report("write:first", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.spare_peer, name: names.other_peer }));

  // The owner is now poisoned. getContext and answerChat must both still work.
  await report(
    "getContext:while-poisoned",
    send(context, "getContext", { workspace_name: workspace, peer_name: names.peer, session_name: names.session, max_items: 10 }),
  );
  await report(
    "answerChat:while-poisoned",
    send(chatOver(context), "answerChat", {
      workspace_name: workspace,
      peer_name: names.peer,
      session_name: names.session,
      question: "what happened?",
      max_items: 10,
    }),
  );
  say(`model:calls-after-poisoned-chat ${modelCalls}`);

  // An ORDINARY write is refused on the same, still-poisoned owner.
  await report("write:after-poison", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.third_peer, name: names.third_peer }));

  await bundle.close();
  say("owner:alive");
  await new Promise((resolveHold) => setTimeout(resolveHold, Number(payload.hold_ms ?? 15_000)));
}

if (mode === "answerchat-never-poisons") {
  // A commanded MODEL failure on answerChat must leave the owner perfectly
  // usable: answerChat never touches `core.serial`, so it cannot poison it.
  const bundle = await openContextWriter(root!, options());
  const context = bundle.context;
  const ids = payload.ids as Record<string, string>;
  const names = payload.names as Record<string, string>;

  await report("setup:session", send(context, "registerSession", { workspace_name: workspace, session_id: ids.session, name: names.session }));
  await report("setup:peer", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.peer, name: names.peer }));
  await report("setup:join", send(context, "joinSession", { workspace_name: workspace, session_name: names.session, peer_name: names.peer }));

  payload.model_fail = true;
  await report(
    "answerChat:model-failed",
    send(chatOver(context), "answerChat", {
      workspace_name: workspace,
      peer_name: names.peer,
      session_name: names.session,
      question: "what happened?",
      max_items: 10,
    }),
  );
  payload.model_fail = false;
  // The SAME owner accepts a genuine write right after the model failure.
  await report("write:after-model-failure", send(context, "registerPeer", { workspace_name: workspace, peer_id: ids.spare_peer, name: names.other_peer }));
  await bundle.close();
}

say("done");
