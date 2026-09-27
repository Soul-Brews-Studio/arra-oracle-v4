/** Failing-first (ui-stale round 3, 2026-09-27). Round 2's "latest call
 *  wins" counter was wrong for a STALE CLOSURE: a post-write refresh bound
 *  at click time carried the session / node / workspace of THAT render, and
 *  the counter let its read beat the current selection's. One test per
 *  shape, each through the REAL hook:
 *
 *   - useMemory.send / join: sA's transcript (context) under sB after a
 *     switch mid-append (mid-join).
 *   - useMemory.send then deselect: sA's transcript under no session.
 *   - useEvidenceReview.applyLifecycleWrite: node A's lifecycle rows (and
 *     its write outcome) under node B after a switch mid-retire.
 *   - useListing.refreshAll ([] deps): a workspace switch re-read the FIRST
 *     render's workspace.
 *   - useKnowledge.publish: B-after-S2 must still end on S2.
 *
 * Same harness as `staleReads.audit.test.tsx`: react-dom/client into a fake
 * container, stubbed `fetch` / `localStorage` / `window`, all restored.
 * `bun test src/state/staleClosure.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import type { Bank } from "../api/memory";
import { mintTaxonomyIds } from "../api/knowledge";
import { useEvidenceReview } from "./useEvidenceReview";
import { useKnowledge } from "./useKnowledge";
import { useListing } from "./useListing";
import { useMemory } from "./useMemory";

const BANK: Bank = { bank: "b1", token: "t1", workspace: "w1" };
type Pending = { method: string; key: string; answer: (body: unknown) => void };

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
      pending.push({ method, key, answer: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })) });
    });
  }) as unknown as typeof fetch;
  return pending;
}

async function answer(pending: Pending[], method: string, key: string, body: unknown): Promise<void> {
  const i = pending.findIndex((p) => p.method === method && p.key === key);
  if (i < 0) throw new Error(`no pending ${method}[${key}]; have ${pending.map((p) => `${p.method}[${p.key}]`).join(", ")}`);
  const [p] = pending.splice(i, 1);
  await act(async () => {
    p!.answer(body);
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
}

/** Answer every parked request for `key` (any method), oldest first. */
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

const INPUT = {
  title: "t", body: "b", body_format: "text" as const, type_term: "note" as const,
  horizon: null, author_peer_name: null, session_name: null, change_reason: null, links: [],
};
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe("useMemory: a post-write refresh reads the session on screen, not the one clicked in", () => {
  test("send in sA, switch to sB mid-append: ends on sB's transcript", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory(), null);
    act(() => m.get().setSession("sA"));
    await answer(pending, "listMessages", "sA", { rows: [{ id: "mA0" }] });
    let sent: Promise<void> = Promise.resolve();
    act(() => void (sent = m.get().actions.send("p1", null, "hello")));
    act(() => m.get().setSession("sB"));
    await answer(pending, "appendMessages", "sA", { ok: true });
    // Whatever read(s) are now in flight, B's is answered LAST -- the order
    // the round-2 guard got wrong.
    await answerAll(pending, "sA", () => ({ rows: [{ id: "mA1" }] }));
    await answer(pending, "listMessages", "sB", { rows: [{ id: "mB" }] });
    await answerAll(pending, "sB", () => ({ rows: [{ id: "mB" }] }));
    await act(async () => void (await sent));
    expect(m.get().session).toBe("sB");
    expect(ids(m.get().messages)).toEqual(["mB"]);
    expect(m.get().loadingMessages).toBe(false);
  });

  test("join in sA, switch to sB mid-join (App's [peer, session] effect): ends on sB's context", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => {
      const mem = useMemory();
      // Mirrors App.tsx's context effect, the real second caller.
      useEffect(() => void mem.actions.refreshContext(), [mem.peer, mem.session]); // eslint-disable-line react-hooks/exhaustive-deps
      return mem;
    }, null);
    act(() => m.get().setPeer("p1"));
    act(() => m.get().setSession("sA"));
    await answerAll(pending, "sA", (method) => (method === "getContext" ? { items: [{ id: "cA0" }] } : { rows: [] }));
    let joined: Promise<void> = Promise.resolve();
    act(() => void (joined = m.get().actions.join("sA")));
    act(() => m.get().setSession("sB"));
    await answer(pending, "joinSession", "sA", { ok: true });
    await answerAll(pending, "sA", () => ({ items: [{ id: "cA1" }] }));
    await answerAll(pending, "sB", (method) => (method === "getContext" ? { items: [{ id: "cB" }] } : { rows: [] }));
    await act(async () => void (await joined));
    const context = m.get().context as unknown as { items: Array<{ id: string }> };
    expect(ids(context.items)).toEqual(["cB"]);
    expect(m.get().loadingContext).toBe(false);
  });

  test("send in sA, deselect mid-append: no transcript and no latched loading", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory(), null);
    act(() => m.get().setSession("sA"));
    await answer(pending, "listMessages", "sA", { rows: [{ id: "mA0" }] });
    let sent: Promise<void> = Promise.resolve();
    act(() => void (sent = m.get().actions.send("p1", null, "hello")));
    act(() => m.get().setSession(null));
    expect(m.get().loadingMessages).toBe(false);
    await answer(pending, "appendMessages", "sA", { ok: true });
    await answerAll(pending, "sA", () => ({ rows: [{ id: "mA1" }] }));
    await act(async () => void (await sent));
    expect(m.get().session).toBe(null);
    expect(m.get().messages).toEqual([]);
    expect(m.get().loadingMessages).toBe(false);
  });
});

describe("useEvidenceReview: applyLifecycleWrite refreshes the node on screen", () => {
  test("retire A, switch to B mid-write: B's lifecycle rows, no A outcome under B", async () => {
    const pending = parkedFetch((b) => String(b.node_id ?? b.session_name ?? ""));
    type P = { node: string | null };
    const e = render((p: P) => useEvidenceReview(BANK, p.node, null), { node: "nodeA" });
    const lifecycleBody = (node: string) => (method: string) =>
      method === "listLifecycleHistory"
        ? { rows: [{ event_id: `ev-${node}`, id: `ev-${node}`, node_id: node }], next_after_event_id: null }
        : method === "getRecallEligibility"
          ? { eligible: true, witness_event_id: `w-${node}` }
          : null;
    await answerAll(pending, "nodeA", lifecycleBody("nodeA"));
    act(() => e.get().lifecycle.actions.retire("rev-A", "done"));
    e.set({ node: "nodeB" });
    await answer(pending, "retireNode", "nodeA", { outcome: "accepted" });
    await answerAll(pending, "nodeA", lifecycleBody("nodeA"));
    await answerAll(pending, "nodeB", lifecycleBody("nodeB"));
    const rows = e.get().lifecycle.rows as unknown as Array<{ node_id: string }>;
    expect(rows.map((r) => r.node_id)).toEqual(["nodeB"]);
    expect(e.get().recall.value?.witness_event_id).toBe("w-nodeB");
    expect(e.get().lifecycle.loading).toBe(false);
    expect(e.get().lifecycle.actions.outcome).toBe(null);
  });
});

describe("useEvidenceReview: a key change with NO new read still drops the old one", () => {
  // Pins the KEY half of the guard: a scope switch starts no trace lookup,
  // so only the key (not a newer read) can tell this answer is stale.
  test("a trace looked up in w1 answering after a switch to w2 does not land", async () => {
    const pending = parkedFetch((b) => String(b.workspace_name ?? ""));
    type P = { b: Bank };
    const e = render((p: P) => useEvidenceReview(p.b, null, null), { b: BANK });
    act(() => e.get().trace.setId("trace-1"));
    act(() => e.get().trace.lookup());
    e.set({ b: { ...BANK, workspace: "w2" } });
    await answer(pending, "getTrace", "w1", { id: "trace-1" });
    await answerAll(pending, "w1", () => ({ rows: [], next_after_position: null }));
    expect(e.get().trace.row).toBe(null);
    expect(e.get().trace.loading).toBe(false);
  });
});

describe("useListing: a workspace switch after the first render reads the NEW workspace", () => {
  test("scope change re-reads wsTWO and shows wsTWO's rows, even with wsONE answering last", async () => {
    const pending = parkedFetch((b) => String(b.workspace_name ?? ""));
    type P = { b: Bank };
    const l = render((p: P) => useListing(p.b), { b: { ...BANK, workspace: "wsONE" } });
    l.set({ b: { ...BANK, workspace: "wsTWO" } });
    expect(pending.some((p) => p.key === "wsTWO" && p.method === "listPeers")).toBe(true);
    await answerAll(pending, "wsTWO", () => ({ rows: [{ id: "two" }], next_after_id: null }));
    await answerAll(pending, "wsONE", () => ({ rows: [{ id: "one" }], next_after_id: "stale-cursor" }));
    expect(ids(l.get().peers.state.rows)).toEqual(["two"]);
    expect(ids(l.get().nodes.state.rows)).toEqual(["two"]);
    expect(l.get().nodes.state.hasNext).toBe(false);
    expect(l.get().peers.state.loading).toBe(false);
  });

  test("the refresh-all button after a switch reads the current workspace", async () => {
    const pending = parkedFetch((b) => String(b.workspace_name ?? ""));
    type P = { b: Bank };
    const l = render((p: P) => useListing(p.b), { b: { ...BANK, workspace: "wsONE" } });
    l.set({ b: { ...BANK, workspace: "wsTWO" } });
    await answerAll(pending, "wsONE", () => ({ rows: [], next_after_id: null }));
    await answerAll(pending, "wsTWO", () => ({ rows: [], next_after_id: null }));
    act(() => l.get().refreshAll());
    expect(pending.map((p) => p.key)).toEqual(["wsTWO", "wsTWO", "wsTWO"]);
  });
});

describe("useKnowledge: B-after-S2 still ends on S2", () => {
  test("publish successor S2 from B, B's post-publish read answering last: S2 on screen", async () => {
    const pending = parkedFetch((b) => String(b.node_id ?? (b.content as { node_id?: string } | undefined)?.node_id ?? ""));
    const rev = (node: string) => ({ id: `rev-${node}`, node_id: node, revision_no: "1", title: `title of ${node}`, body: `body of ${node}` });
    const bodyOf = (node: string) => (method: string) =>
      method === "getAcceptedHead"
        ? { node: { id: node }, revision: rev(node) }
        : { node: { id: node }, snapshot_head_revision_id: `rev-${node}`, revisions: [rev(node)] };
    localStorage.setItem("arra-ui-v2-taxonomy:b1:w1", JSON.stringify(mintTaxonomyIds()));
    const k = render(() => useKnowledge(BANK), null);
    act(() => k.get().setSelected("nodeB"));
    await answerAll(pending, "nodeB", bodyOf("nodeB"));
    let published: Promise<boolean> = Promise.resolve(false);
    act(() => void (published = k.get().actions.publish(INPUT, "nodeS2", null)));
    const write = pending.find((p) => p.method === "publishRevision");
    if (write === undefined) throw new Error(`no publish; have ${pending.map((p) => p.method).join(", ")}`);
    await answer(pending, "publishRevision", write.key, { outcome: "accepted", revision_id: "rev-nodeS2" });
    await answerAll(pending, "nodeS2", bodyOf("nodeS2"));
    await answerAll(pending, "nodeB", bodyOf("nodeB"));
    await act(async () => void (await published));
    expect(k.get().selected).toBe("nodeS2");
    expect(k.get().head?.revision?.node_id).toBe("nodeS2");
    expect(k.get().loading).toBe(false);
  });
});

/** ui-reads2 (r3 verifier finding 3): a load-more ticket came from `peek()`,
 *  which shares the seq of whatever read is in flight -- so a page issued for
 *  one result was appended to the NEXT one. The ticket is now bound to the
 *  result it extends: its key and the cursor it was issued for. */
describe("load-more is bound to the result it extends", () => {
  // `trace_id`/`id` names the trace, `after_position`/`cursor` the page.
  const pageKey = (b: Record<string, unknown>) =>
    `${String(b.trace_id ?? b.id ?? b.session_name ?? "")}|${String(b.after_position ?? b.cursor ?? "")}`;
  const hit = (ref: string) => ({ trace_id: ref.slice(0, 2), ref, position: ref });
  const refs = (rows: Array<{ ref: string }>) => rows.map((r) => r.ref);

  test("trace hits: t1's next page answering after t2's lookup never lands on t2", async () => {
    const pending = parkedFetch(pageKey);
    const e = render(() => useEvidenceReview(BANK, null, null), null);
    act(() => e.get().trace.setId("t1"));
    act(() => e.get().trace.lookup());
    await answer(pending, "getTrace", "t1|", { id: "t1" });
    await answer(pending, "listTraceHits", "t1|", { rows: [hit("t1-p1")], next_after_position: "c1" });
    act(() => e.get().trace.setId("t2"));
    act(() => e.get().trace.lookup());
    act(() => e.get().hits.loadMore()); // t1 is still on screen: "more of t1"
    await answer(pending, "getTrace", "t2|", { id: "t2" });
    await answer(pending, "listTraceHits", "t2|", { rows: [hit("t2-p1")], next_after_position: null });
    await answerAll(pending, "t1|c1", () => ({ rows: [hit("t1-p2")], next_after_position: null }));
    expect(e.get().trace.row?.id).toBe("t2");
    expect(refs(e.get().hits.rows)).toEqual(["t2-p1"]);
  });

  test("session links: sA's cursor is never sent for sB, and nothing lands on sB but sB's page", async () => {
    const pending = parkedFetch(pageKey);
    type P = { s: string };
    const e = render((p: P) => useEvidenceReview(BANK, null, p.s), { s: "sA" });
    await answer(pending, "listSessionLinks", "sA|", { rows: [{ id: "A-p1" }], next_cursor: "cA" });
    e.set({ s: "sB" });
    act(() => e.get().sessionLinks.loadMore()); // sB's first page is still in flight
    expect(pending.map((p) => p.key)).not.toContain("sB|cA");
    await answerAll(pending, "sB|cA", () => ({ rows: [{ id: "B-after-cA" }], next_cursor: null }));
    await answerAll(pending, "sA|cA", () => ({ rows: [{ id: "A-p2" }], next_cursor: null }));
    await answer(pending, "listSessionLinks", "sB|", { rows: [{ id: "B-p1" }], next_cursor: null });
    expect(ids(e.get().sessionLinks.rows)).toEqual(["B-p1"]);
  });
});
