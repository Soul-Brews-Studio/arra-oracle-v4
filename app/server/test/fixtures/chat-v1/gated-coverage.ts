// Owned test child for #85 / overnight ruling R4 (`coverage` means complete).
//
// Runs INSIDE the writer gate, seeds one scenario per coverage rule into ONE
// fresh dataset, then drives `context.getContext` (and `answerChat` where the
// model boundary matters) and prints one JSON line keyed by scenario. Every
// scenario lives in its own sessions, so they cannot see each other's rows.
//
// The clock is MUTABLE and bumped before every append: `getContext` orders
// candidates across sessions by `created_at`, so a fixed clock would leave the
// "newer"/"older" arrangement each scenario depends on to a public_id tiebreak.
//
// The MODEL is a recording in-process stub -- code, never JSON-serialized --
// so the parent can prove unauthorized evidence never reached its input.
const [, , datasetRoot] = Bun.argv;

const { openContextWriter } = await import(
  new URL("../../../src/publication/service.ts", import.meta.url).pathname
);
// #32 / R9: `answerChat` is a chat-facade method over a reader's context,
// no longer a writer method; the stub model is composed there, not into the
// writer's options.
const { createChatService } = await import(
  new URL("../../../src/publication/service.createChatService.ts", import.meta.url).pathname
);

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

let now = Date.parse("2026-09-21T00:00:00.000Z");
const modelInputs: unknown[] = [];
const model = async (input: unknown) => {
  modelInputs.push(input);
  return "stub answer";
};

const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => "unusedunusedunused000",
  clock: () => now,
  sourceNamespace: null,
});
const chat = createChatService(service.context, { model, settings: null });

const WS = "alpha-workspace";
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const call = async (method: string, request: unknown) => {
  const facade = method === "answerChat" ? chat : service.context;
  const fn = (facade as Record<string, (b: Uint8Array) => Promise<unknown>>)[method]!;
  return fn(enc(request));
};

let sessionCounter = 0;
const session = async (name: string, members: string[]) => {
  sessionCounter++;
  await call("registerSession", { workspace_name: WS, session_id: pad(`sess${sessionCounter}x`), name });
  for (const peer of members) await call("joinSession", { workspace_name: WS, session_name: name, peer_name: peer });
};

let linkCounter = 0;
const link = async (from: string, to: string) => {
  linkCounter++;
  // Zero-padded so `id` ascending (the order getContext reads links in) is
  // also creation order: the LAST link created is the one past the bound.
  await call("createSessionLink", {
    id: pad(`lnk${String(linkCounter).padStart(3, "0")}x`),
    workspace_name: WS,
    from_session_name: from,
    to_session_name: to,
    relation: "related_to",
    evidence_ref: null,
    created_by_peer_name: null,
  });
};

const append = async (sessionName: string, peer: string, messages: { id: string; content: string }[]) => {
  now += 1000;
  await call("appendMessages", {
    workspace_name: WS,
    session_name: sessionName,
    items: messages.map((m) => ({
      public_id: m.id,
      message: { peer_name: peer, role: null, content: m.content, in_reply_to: null },
      source: null,
    })),
  });
};

const attempt = async (method: string, request: unknown) => {
  try {
    return { ok: true, value: await call(method, request) };
  } catch (error) {
    const e = error as { name?: string; code?: string; path?: string; message?: string };
    return { ok: false, name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, message: String(e.message ?? e) };
  }
};

const context = (sessionName: string, maxItems: number) =>
  attempt("getContext", { workspace_name: WS, peer_name: "peer-a", session_name: sessionName, max_items: maxItems });

const out: Record<string, unknown> = {};

try {
  await call("registerPeer", { workspace_name: WS, peer_id: pad("peer-a-id"), name: "peer-a" });
  await call("registerPeer", { workspace_name: WS, peer_id: pad("peer-b-id"), name: "peer-b" });

  // unauth: the issue title. Ample budget, one authorized anchor message and
  // one linked message from a session the requester never joined.
  await session("unauth-main", ["peer-a"]);
  await session("unauth-secret-session", ["peer-b"]);
  await link("unauth-main", "unauth-secret-session");
  await append("unauth-main", "peer-a", [{ id: pad("unauthok1"), content: "authorized visible message" }]);
  await append("unauth-secret-session", "peer-b", [{ id: pad("unauthSECRET1"), content: "SECRET unauthorized content" }]);
  out.unauth = await context("unauth-main", 10);
  const before = modelInputs.length;
  out.unauthAnswer = await attempt("answerChat", {
    workspace_name: WS,
    peer_name: "peer-a",
    session_name: "unauth-main",
    question: "what happened?",
    max_items: 10,
  });
  out.unauthModelInputs = modelInputs.slice(before);

  // full: every candidate authorized (the requester is a member of the
  // linked session too) and everything fits.
  await session("full-main", ["peer-a"]);
  await session("full-linked", ["peer-a", "peer-b"]);
  await link("full-main", "full-linked");
  await append("full-linked", "peer-b", [{ id: pad("fullok1"), content: "linked, authorized" }]);
  await append("full-main", "peer-a", [{ id: pad("fullok2"), content: "anchor, authorized" }]);
  out.full = await context("full-main", 10);
  out.fullAnswer = await attempt("answerChat", {
    workspace_name: WS,
    peer_name: "peer-a",
    session_name: "full-main",
    question: "what happened?",
    max_items: 10,
  });

  // count: three authorized messages, max_items 2 -- the oldest is cut.
  await session("count-main", ["peer-a"]);
  await append("count-main", "peer-a", [{ id: pad("countold"), content: "oldest" }]);
  await append("count-main", "peer-a", [{ id: pad("countmid"), content: "middle" }]);
  await append("count-main", "peer-a", [{ id: pad("countnew"), content: "newest" }]);
  out.count = await context("count-main", 2);

  // wire: three ~30 KB authorized messages; only two fit MAX_CONTEXT_WIRE_BYTES.
  await session("wire-main", ["peer-a"]);
  await append("wire-main", "peer-a", [{ id: pad("wireold"), content: "o".repeat(30_000) }]);
  await append("wire-main", "peer-a", [{ id: pad("wiremid"), content: "m".repeat(30_000) }]);
  await append("wire-main", "peer-a", [{ id: pad("wirenew"), content: "n".repeat(30_000) }]);
  out.wire = await context("wire-main", 10);

  // afterCap: the unauthorized candidate is OLDER than two authorized ones,
  // with max_items 2. It must be counted as unauthorized, never relabelled
  // `budget_exceeded` with its identifiers attached.
  await session("aftercap-main", ["peer-a"]);
  await session("aftercap-secret-session", ["peer-b"]);
  await link("aftercap-main", "aftercap-secret-session");
  await append("aftercap-secret-session", "peer-b", [{ id: pad("aftercapSECRET1"), content: "SECRET older" }]);
  await append("aftercap-main", "peer-a", [
    { id: pad("aftercapok1"), content: "authorized one" },
    { id: pad("aftercapok2"), content: "authorized two" },
  ]);
  out.afterCap = await context("aftercap-main", 2);

  // links: nine linked sessions, ALL authorized, one message each. Only the
  // first MAX_LINKED_SESSIONS (8) are searched; the ninth must be reported.
  await session("links-main", ["peer-a"]);
  await append("links-main", "peer-a", [{ id: pad("linksanchor"), content: "anchor" }]);
  for (let i = 0; i < 9; i++) {
    const name = `links-linked-${i}`;
    await session(name, ["peer-a"]);
    await link("links-main", name);
    await append(name, "peer-a", [{ id: pad(`linksmsg${i}`), content: `linked ${i}` }]);
  }
  out.links = await context("links-main", 50);

  // manyUnauth: 8 linked sessions the requester never joined, 6 messages
  // each (= max_items + 1, the per-session lookahead, at max_items 5), plus
  // one authorized anchor message. One aggregate entry, no identifiers.
  await session("many-main", ["peer-a"]);
  for (let s = 0; s < 8; s++) {
    const name = `many-SECRET-session-${s}`;
    await session(name, ["peer-b"]);
    await link("many-main", name);
    await append(
      name,
      "peer-b",
      Array.from({ length: 6 }, (_, i) => ({ id: pad(`mSECRET${s}m${i}x`), content: `SECRET ${s}/${i}` })),
    );
  }
  await append("many-main", "peer-a", [{ id: pad("manyok1"), content: "authorized" }]);
  out.manyUnauth = await context("many-main", 5);

  // overflow: an anchor and 4 AUTHORIZED linked sessions, all with 250-byte
  // names, 51 messages each (max_items 50 + 1). 255 candidates, 50 fit; the
  // 205 budget entries at 333 bytes each exceed the excluded list's own
  // 65536-byte bound (196 entries), which must be signalled, not hidden.
  const overflowMain = "overflow-main-".padEnd(250, "x");
  await session(overflowMain, ["peer-a"]);
  for (let s = 0; s < 5; s++) {
    const name = s === 0 ? overflowMain : `overflow-linked-${s}-`.padEnd(250, "x");
    if (s > 0) {
      await session(name, ["peer-a"]);
      await link(overflowMain, name);
    }
    await append(
      name,
      "peer-a",
      Array.from({ length: 51 }, (_, i) => ({ id: pad(`ovf${s}m${i}x`), content: `authorized ${s}/${i}` })),
    );
  }
  out.overflow = await context(overflowMain, 50);
} catch (error) {
  const e = error as { name?: string; code?: string; path?: string; message?: string };
  out.error = { name: e?.name, code: e?.code, path: e?.path, message: String(e?.message ?? e) };
} finally {
  await service.close().catch(() => undefined);
}

console.log(JSON.stringify(out));
