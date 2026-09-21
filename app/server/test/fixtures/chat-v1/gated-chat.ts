// Owned test child for the #32 chat kernel smoke test.
//
// Runs INSIDE the writer gate, seeds two peers / two sessions / one session
// link / two messages (one the requester may see, one it may not), then
// drives `context.getContext` and `context.answerChat` and prints one JSON
// line. The MODEL is a real in-process stub -- never JSON-serialized, since
// it is code, not data -- so this is the one place a "model call" can be
// counted without any network or SDK involved.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  modelMode: "ok" | "fail";
  getContextArgs: Record<string, unknown>;
  answerChatArgs?: Record<string, unknown>;
};

const { openContextWriter } = await import(
  new URL("../../../src/publication/service.ts", import.meta.url).pathname
);

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; toJSON?: () => { version?: string } };
  let version: string | null = null;
  try {
    version = typeof e.toJSON === "function" ? (e.toJSON().version ?? null) : null;
  } catch {
    version = null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version };
};

let modelCalls = 0;
let lastModelInput: unknown = null;
const model = async (input: unknown) => {
  modelCalls++;
  lastModelInput = input;
  if (payload.modelMode === "fail") throw new Error("commanded model failure");
  return "stub answer";
};

const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => "unusedunusedunused000",
  clock: () => Date.parse("2026-09-21T00:00:00.000Z"),
  sourceNamespace: null,
  model,
});

const WS = "alpha-workspace";
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const call = async (method: string, request: unknown) => {
  const fn = (service.context as Record<string, (b: Uint8Array) => Promise<unknown>>)[method]!;
  return fn(enc(request));
};

const results: Record<string, unknown> = {};

try {
  // Two peers, two sessions: the requester joins only "session-main".
  await call("registerPeer", { workspace_name: WS, peer_id: pad("peer-a-id"), name: "peer-a" });
  await call("registerPeer", { workspace_name: WS, peer_id: pad("peer-b-id"), name: "peer-b" });
  await call("registerSession", { workspace_name: WS, session_id: pad("sess-main-id"), name: "session-main" });
  await call("registerSession", { workspace_name: WS, session_id: pad("sess-other-id"), name: "session-other" });
  await call("joinSession", { workspace_name: WS, session_name: "session-main", peer_name: "peer-a" });
  await call("joinSession", { workspace_name: WS, session_name: "session-other", peer_name: "peer-b" });

  // Link session-main -> session-other, so getContext considers the OTHER
  // session's messages as candidates too -- exactly the shape that makes
  // per-item authorization meaningful rather than vacuous.
  await call("createSessionLink", {
    id: pad("link-1"),
    workspace_name: WS,
    from_session_name: "session-main",
    to_session_name: "session-other",
    relation: "related_to",
    evidence_ref: null,
    created_by_peer_name: null,
  });

  const visibleId = pad("msg-visible");
  const visibleId2 = pad("msg-visible-2");
  const secretId = pad("msg-secret");
  await call("appendMessages", {
    workspace_name: WS,
    session_name: "session-main",
    items: [
      {
        public_id: visibleId,
        message: { peer_name: "peer-a", role: null, content: "authorized visible message", in_reply_to: null },
        source: null,
      },
      {
        public_id: visibleId2,
        message: { peer_name: "peer-a", role: null, content: "authorized visible message two", in_reply_to: null },
        source: null,
      },
    ],
  });
  await call("appendMessages", {
    workspace_name: WS,
    session_name: "session-other",
    items: [
      {
        public_id: secretId,
        message: { peer_name: "peer-b", role: null, content: "secret unauthorized message", in_reply_to: null },
        source: null,
      },
    ],
  });
  results.visibleId = visibleId;
  results.visibleId2 = visibleId2;
  results.secretId = secretId;

  try {
    results.getContext = { ok: true, value: await call("getContext", payload.getContextArgs) };
  } catch (error) {
    results.getContext = { ok: false, ...describeError(error) };
  }
  results.modelCallsAfterGetContext = modelCalls;

  // Always proven, regardless of payload: the PublicationError family still
  // guards chat's own stored-state / reference failures (a session this
  // workspace never registered).
  try {
    results.absentSession = {
      ok: true,
      value: await call("getContext", {
        workspace_name: WS,
        peer_name: "peer-a",
        session_name: "session-does-not-exist",
        max_items: 5,
      }),
    };
  } catch (error) {
    results.absentSession = { ok: false, ...describeError(error) };
  }

  if (payload.answerChatArgs) {
    try {
      results.answerChat = { ok: true, value: await call("answerChat", payload.answerChatArgs) };
    } catch (error) {
      results.answerChat = { ok: false, ...describeError(error) };
    }
    results.modelCallsAfterAnswer = modelCalls;
    results.lastModelInput = lastModelInput;
  }
} finally {
  await service.close().catch(() => undefined);
}

console.log(JSON.stringify(results));
