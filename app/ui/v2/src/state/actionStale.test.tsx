/** Failing-first (ui-actions, 2026-09-27). PR #118 keyed the READS
 *  (`useKeyedRead`). It left every async ACTION result and action error
 *  unkeyed: a response for a selection already left could still land under
 *  whatever is on screen now. One test per shape, each through the REAL hook:
 *
 *   - useMemory.ask: sA's chat answer must not land under sB
 *     (useMemory.ts ~221-234, named in the #33 acceptor verdict and
 *     docs/overnight/UI-PROOF-ui-stale.md).
 *   - useMemory.send failure: a stale `messageError` must not paint under
 *     the session switched to after the send.
 *   - useKnowledge.seed: a stale taxonomy pin must not land under a
 *     workspace switched to after the seed.
 *   - useMemory.verify (roster peers/sessions): a stale verdict must not
 *     overwrite a same-named bookmark in a workspace switched to after the
 *     verify (name collision across workspaces is exactly the case that
 *     hides the bug -- a mismatched name would just no-op).
 *
 * Policy for every one of these, stated once here because it is the same
 * reasoning every time: DROP. None of the four has a place to attribute a
 * stale result TO (the chat pane, the composer's error line, the taxonomy
 * pin and a roster entry are all single-slot, "what's true for the
 * selection on screen", not a per-session/per-workspace log) -- so a result
 * that arrives for a selection already left is discarded, exactly like
 * `useKeyedRead`'s read guard drops a stale read.
 *
 * Same harness as `staleClosure.test.tsx`: react-dom/client into a fake
 * container, stubbed `fetch` / `localStorage` / `window`, all restored.
 * `bun test src/state/actionStale.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import type { Bank } from "../api/memory";
import { mintTaxonomyIds } from "../api/knowledge";
import { useKnowledge } from "./useKnowledge";
import { useMemory } from "./useMemory";

const BANK: Bank = { bank: "b1", token: "t1", workspace: "w1" };
type Pending = { method: string; key: string; answer: (body: unknown, status?: number) => void };

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, localStorage: g.localStorage, act: g.IS_REACT_ACT_ENVIRONMENT, fetch: globalThis.fetch };
let root: Root | null = null;

beforeAll(() => {
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = {
    HTMLIFrameElement: class {},
    location: { search: "", pathname: "/", hash: "" },
    history: { replaceState() {} },
  };
});
beforeEach(() => {
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  globalThis.fetch = saved.fetch;
});
afterAll(() => {
  g.window = saved.window;
  g.localStorage = saved.localStorage;
  g.IS_REACT_ACT_ENVIRONMENT = saved.act;
});

/** Park every request; `keyOf` names which selection it was issued for. */
function parkedFetch(keyOf: (body: Record<string, unknown>) => string): Pending[] {
  const pending: Pending[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const key = keyOf(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Promise<Response>((resolve) => {
      pending.push({
        method,
        key,
        answer: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
      });
    });
  }) as unknown as typeof fetch;
  return pending;
}

/** Same as `parkedFetch`, keyed on the bearer token instead of the body --
 *  `token` never rides in the request body (it is the `authorization`
 *  header, see `api/client.ts`), so a token-freshness test cannot key on the
 *  body the way a workspace/session one does. */
function parkedFetchByToken(): Pending[] {
  const pending: Pending[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const key = auth.replace(/^Bearer /, "");
    return new Promise<Response>((resolve) => {
      pending.push({
        method,
        key,
        answer: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
      });
    });
  }) as unknown as typeof fetch;
  return pending;
}

async function answer(pending: Pending[], method: string, key: string, body: unknown, status = 200): Promise<void> {
  const i = pending.findIndex((p) => p.method === method && p.key === key);
  if (i < 0) throw new Error(`no pending ${method}[${key}]; have ${pending.map((p) => `${p.method}[${p.key}]`).join(", ")}`);
  const [p] = pending.splice(i, 1);
  await act(async () => {
    p!.answer(body, status);
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
}

async function answerAll(pending: Pending[], key: string, bodyOf: (method: string) => unknown): Promise<void> {
  while (pending.some((p) => p.key === key)) {
    const p = pending.find((q) => q.key === key)!;
    await answer(pending, p.method, key, bodyOf(p.method));
  }
}

function render<P, T>(useHook: (p: P) => T, initial: P): { get: () => T; set: (p: P) => void } {
  let value: T | null = null;
  function Harness({ p }: { p: P }) {
    value = useHook(p);
    return null;
  }
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: null, ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} };
  root = createRoot(container as unknown as Element);
  act(() => root!.render(<Harness p={initial} />));
  return { get: () => value!, set: (p: P) => act(() => root!.render(<Harness p={p} />)) };
}

describe("useMemory.ask: an answer for a selection already left is dropped", () => {
  test("ask in sA, switch to sB mid-ask: no sA answer under sB", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory(), null);
    act(() => m.get().setPeer("p1"));
    act(() => m.get().setSession("sA"));
    await answerAll(pending, "sA", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    act(() => void m.get().actions.ask("what happened?", 10));
    act(() => m.get().setSession("sB"));
    await answer(pending, "answerChat", "sA", { answer: "sA's answer", items_used: [] });
    await answerAll(pending, "sB", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    expect(m.get().session).toBe("sB");
    expect(m.get().answer).toBe(null);
    expect(m.get().askError).toBe(null);
    expect(m.get().asking).toBe(false);
  });
});

describe("useMemory.send: a failure for a session already left does not paint messageError", () => {
  test("send fails in sA after switching to sB: messageError stays clear", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory(), null);
    act(() => m.get().setSession("sA"));
    await answer(pending, "listMessages", "sA", { rows: [] });
    act(() => void m.get().actions.send("p1", null, "hello"));
    act(() => m.get().setSession("sB"));
    await answer(pending, "appendMessages", "sA", { code: "conflict" }, 409);
    await answer(pending, "listMessages", "sB", { rows: [{ id: "mB" }] });
    expect(m.get().session).toBe("sB");
    expect(m.get().messageError).toBe(null);
    expect(m.get().sending).toBe(false);
  });
});

describe("useKnowledge.seed: a stale taxonomy pin does not land under a workspace switched to", () => {
  test("seed resolves in w1 after switching to w2: w2's taxonomy stays unset", async () => {
    const pending = parkedFetch((b) => String(b.workspace_name ?? ""));
    type P = { b: Bank };
    const k = render((p: P) => useKnowledge(p.b), { b: BANK });
    act(() => void k.get().actions.seed());
    k.set({ b: { ...BANK, workspace: "w2" } });
    await answer(pending, "seedReservedVocabularies", "w1", { already_seeded: false });
    expect(k.get().taxonomy).toBe(null);
    expect(k.get().error).toBe(null);
  });
});

describe("useMemory.verify: a stale verdict does not overwrite a same-named bookmark in another workspace", () => {
  test("alice verified live in w2 stays live after w1's stale 'missing' answer lands", async () => {
    const pending = parkedFetch((b) => String(b.workspace_name ?? ""));
    const m = render(() => useMemory(), null);
    act(() => m.get().setWorkspace("w1"));
    act(() => m.get().actions.addPeer("alice")); // verify -> getPeer(w1, alice)
    act(() => m.get().setWorkspace("w2")); // resets roster, drops peer/session
    act(() => m.get().actions.addPeer("alice")); // verify -> getPeer(w2, alice)
    // w2's own verify resolves first: alice is live in w2.
    await answer(pending, "getPeer", "w2", { peer_name: "alice" });
    // w1's stale verify resolves after: an invalid_reference "missing" verdict
    // for a workspace already left.
    await answer(pending, "getPeer", "w1", { error: { code: "invalid_reference" } }, 404);
    const alice = m.get().roster.peers.find((e) => e.name === "alice");
    expect(alice?.state).toBe("live");
  });
});

/** Fix round (2026-09-27): an independent verifier refuted round 1. The four
 *  cases above pinned only the IN-FLIGHT race (switch before the response
 *  arrives) -- `askRead.land()` already dropped those. What was missing:
 *
 *   - a chat answer/error that already SETTLED while the selection it was
 *     asked for was still on screen is never cleared when you later move on
 *     (useMemory.ts ~82/248-266: nothing calls setAnswer/setAskError on a
 *     peer/session/bank/workspace/token change).
 *   - `asking` was a single unkeyed flag: asking in sA and switching to sB
 *     showed "Asking..." under sB until sA's model call returned.
 *   - `useKnowledge.publish` dropped the forced navigation on a scope switch
 *     but still RESOLVED `true`, so both `KnowledgeView` call sites navigated
 *     anyway (`.then((ok) => { if (!ok) return; ...onSelectNode... })`).
 *   - `useMemory.verify`'s freshness check compared only `workspace`, not
 *     `[bank, workspace, token]` like every other key in this hook -- a
 *     verify issued under an old TOKEN could still overwrite one from the
 *     current token in the very same workspace. */
describe("useMemory.ask: a SETTLED answer/error is cleared once the selection moves on (not just guarded in flight)", () => {
  test("ask settles in sA, then switch to sB: sA's answer is cleared, not shown under sB", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory(), null);
    act(() => m.get().setPeer("p1"));
    act(() => m.get().setSession("sA"));
    await answerAll(pending, "sA", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    act(() => void m.get().actions.ask("what happened?", 10));
    await answer(pending, "answerChat", "sA", { answer: "sA's answer", items_used: ["mA1"] });
    // Settled while sA was still on screen: a real, correctly-landed answer.
    expect(m.get().answer?.answer).toBe("sA's answer");
    act(() => m.get().setSession("sB"));
    await answerAll(pending, "sB", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    expect(m.get().session).toBe("sB");
    expect(m.get().answer).toBe(null);
    expect(m.get().askError).toBe(null);
  });

  test("askError settles in sA, then switch to sB: askError is cleared", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory(), null);
    act(() => m.get().setPeer("p1"));
    act(() => m.get().setSession("sA"));
    await answerAll(pending, "sA", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    act(() => void m.get().actions.ask("what happened?", 10));
    await answer(pending, "answerChat", "sA", { error: { code: "model_unavailable" } }, 503);
    expect(m.get().askError).toBe("model_unavailable");
    act(() => m.get().setSession("sB"));
    await answerAll(pending, "sB", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    expect(m.get().askError).toBe(null);
  });
});

describe("useMemory.ask: `asking` is keyed to the current selection", () => {
  test("switching to sB while sA's ask is in flight clears `asking` immediately", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory(), null);
    act(() => m.get().setPeer("p1"));
    act(() => m.get().setSession("sA"));
    await answerAll(pending, "sA", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    act(() => void m.get().actions.ask("what happened?", 10));
    expect(m.get().asking).toBe(true);
    act(() => m.get().setSession("sB"));
    // sA's answerChat is still parked/unanswered -- `asking` must not still
    // read true for sB just because SOME request is in flight.
    expect(m.get().asking).toBe(false);
    await answer(pending, "answerChat", "sA", { answer: "sA's answer", items_used: [] });
    await answerAll(pending, "sB", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    expect(m.get().asking).toBe(false);
    expect(m.get().answer).toBe(null);
  });

  // Wave-8 verifier (round 2, blocking): land() returned false for sA's
  // dropped answer WITHOUT clearing the pending marker, so going back to sA
  // read `asking` true forever -- no read was in flight any more.
  test("sA's dropped answer finishing clears the pending marker: back on sA, `asking` is false", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory(), null);
    act(() => m.get().setPeer("p1"));
    act(() => m.get().setSession("sA"));
    await answerAll(pending, "sA", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    act(() => void m.get().actions.ask("what happened?", 10));
    act(() => m.get().setSession("sB"));
    await answerAll(pending, "sB", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    await answer(pending, "answerChat", "sA", { answer: "sA's answer", items_used: [] });
    act(() => m.get().setSession("sA"));
    await answerAll(pending, "sA", (method) => (method === "getContext" ? { items: [] } : { rows: [] }));
    expect(m.get().asking).toBe(false);
    expect(m.get().answer).toBe(null);
  });
});

describe("useKnowledge.publish: a scope switch after publish resolves ok drops the forced navigation for real", () => {
  const NODE = "nodeAAAAAAAAAAAAAAAAA";
  const INPUT = {
    title: "t", body: "b", body_format: "text" as const, type_term: "note" as const,
    horizon: null, author_peer_name: null, session_name: null, change_reason: null, links: [],
  };

  test("publish resolves false (not true) after a scope switch, so KnowledgeView's `.then` does not navigate", async () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem(
      `arra-ui-v2-taxonomy:${BANK.bank}:${BANK.workspace}`,
      JSON.stringify(mintTaxonomyIds()),
    );
    // `publishRevision`'s body nests `workspace_name` under `content`, unlike
    // every other method here -- see `api/knowledge.ts`'s `publishRevision`.
    const pending = parkedFetch(
      (b) => String((b.content as Record<string, unknown> | undefined)?.workspace_name ?? b.workspace_name ?? ""),
    );
    type P = { b: Bank };
    const k = render((p: P) => useKnowledge(p.b), { b: BANK });
    let resolved: boolean | null = null;
    act(() => {
      void k.get().actions.publish(INPUT, NODE, null).then((ok) => {
        resolved = ok;
      });
    });
    k.set({ b: { ...BANK, workspace: "w2" } });
    await answer(pending, "publishRevision", "w1", { outcome: "accepted" });
    await answerAll(pending, "w1", () => null); // the post-success refresh, if any lands for w1
    expect(resolved).toBe(false);
    expect(k.get().selected).toBe(null);
    expect(k.get().nodes.some((n) => n.name === NODE)).toBe(false);
  });
});

describe("useMemory.verify: a stale verdict from an old TOKEN does not overwrite the current one", () => {
  test("bad-token verify landing after good-token verify leaves alice live", async () => {
    const pending = parkedFetchByToken();
    const m = render(() => useMemory(), null);
    act(() => m.get().setToken("bad"));
    act(() => m.get().actions.addPeer("alice")); // verify -> getPeer, token "bad"
    act(() => m.get().setToken("good"));
    act(() => void m.get().actions.verifyAll()); // re-verify -> getPeer, token "good"
    // The current token's verify answers first: alice is live.
    await answer(pending, "getPeer", "good", { peer_name: "alice" });
    // The stale, already-superseded token's verify answers after -- same
    // workspace, so the old `workspace`-only guard would let this overwrite.
    await answer(pending, "getPeer", "bad", { error: { code: "unauthorized" } }, 401);
    const alice = m.get().roster.peers.find((e) => e.name === "alice");
    expect(alice?.state).toBe("live");
  });
});
