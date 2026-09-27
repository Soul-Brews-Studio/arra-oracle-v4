/** ui-stale fix round (2026-09-27): the stale-response guards dropped a read
 *  that had already set `loading: true`. When the read was dropped by a
 *  DESELECTION (a null node, session or peer) rather than by a newer read,
 *  nothing ever set loading back to false, so the flag stuck on:
 *
 *   - useKnowledge: open B, then switch workspace (or click "New"). NodeHead
 *     read "loading…" and RevisionHistory "loading history…" until another
 *     node was opened. Pre-fix it settled on "no accepted revision".
 *   - useMemory: the same shape via a workspace switch. ForumView sat on
 *     "Loading — Fetching messages…" and ContextPanel's Refresh stayed
 *     disabled.
 *   - useEvidenceReview (pre-existing, same shape): deselecting the node or
 *     session mid-read, or a scope switch mid-trace-lookup.
 *
 *  Needs no race for the first two. The workspace effect clears the selection
 *  one render AFTER the refresh effect has already started a read with the
 *  new bank and the old selection. Every test asserts loading settles to
 *  false once nothing is selected. Same harness as `staleReads.audit.test.tsx`.
 *  `bun test src/state/loadingLatch.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import type { Bank } from "../api/memory";
import { useEvidenceReview } from "./useEvidenceReview";
import { useKnowledge } from "./useKnowledge";
import { useMemory } from "./useMemory";

const B = "nodeBBBBBBBBBBBBBBBBB";
type Pending = { method: string; answer: (body: unknown) => void };

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

/** Park every request until the test answers it by method name. */
function parkedFetch(): Pending[] {
  const pending: Pending[] = [];
  globalThis.fetch = ((url: string) => {
    const method = url.split("/").pop() ?? "";
    return new Promise<Response>((resolve) => {
      pending.push({ method, answer: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })) });
    });
  }) as unknown as typeof fetch;
  return pending;
}

/** Answer EVERY parked request for `method` (a re-issued read parks twice). */
async function answerAll(pending: Pending[], method: string, body: unknown): Promise<void> {
  const hits = pending.filter((p) => p.method === method);
  if (hits.length === 0) throw new Error(`no pending ${method}; have ${pending.map((p) => p.method).join(", ")}`);
  for (const p of hits) pending.splice(pending.indexOf(p), 1);
  await act(async () => {
    for (const p of hits) p.answer(body);
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
}

function render<P>(useHook: (props: P) => unknown, first: P): { rerender: (props: P) => void } {
  function Harness({ props }: { props: P }) {
    useHook(props);
    return null;
  }
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: null, ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} };
  root = createRoot(container as unknown as Element);
  act(() => root!.render(<Harness props={first} />));
  return { rerender: (props) => act(() => root!.render(<Harness props={props} />)) };
}

const revision = { id: "rev-B", node_id: B, revision_no: "1", title: "title of B", body: "body of B" };

describe("useKnowledge: loading settles when the selection is cleared", () => {
  test("a workspace switch after node B has settled leaves loading false", async () => {
    const pending = parkedFetch();
    let k: ReturnType<typeof useKnowledge> | null = null;
    const bank = (workspace: string): Bank => ({ bank: "b1", token: "t1", workspace });
    const view = render((b: Bank) => void (k = useKnowledge(b)), bank("ws1"));
    act(() => k!.setSelected(B));
    await answerAll(pending, "getAcceptedHead", { node: { id: B }, revision });
    await answerAll(pending, "listAcceptedHistory", { node: { id: B }, revisions: [revision] });
    expect(k!.loading).toBe(false);
    view.rerender(bank("ws2"));
    await flush();
    expect(k!.selected).toBeNull();
    expect(k!.head).toBeNull();
    expect(k!.loading).toBe(false);
  });

  test("clicking New while B's head is in flight leaves loading false", async () => {
    parkedFetch();
    let k: ReturnType<typeof useKnowledge> | null = null;
    render((b: Bank) => void (k = useKnowledge(b)), { bank: "b1", token: "t1", workspace: "ws1" });
    act(() => k!.setSelected(B));
    expect(k!.loading).toBe(true);
    act(() => k!.setSelected(null));
    await flush();
    expect(k!.loading).toBe(false);
  });
});

describe("useMemory: loading settles when the session is cleared", () => {
  test("a workspace switch after session sA has settled leaves loadingMessages false", async () => {
    const pending = parkedFetch();
    let m: ReturnType<typeof useMemory> | null = null;
    render(() => void (m = useMemory()), null);
    act(() => m!.setSession("sA"));
    await answerAll(pending, "listMessages", { rows: [{ id: "mA" }] });
    expect(m!.loadingMessages).toBe(false);
    act(() => m!.setWorkspace("ws2"));
    await flush();
    expect(m!.session).toBeNull();
    expect(m!.loadingMessages).toBe(false);
  });

  test("a workspace switch while getContext is in flight leaves loadingContext false", async () => {
    parkedFetch();
    let m: ReturnType<typeof useMemory> | null = null;
    // App.tsx refreshes context on every peer/session change; mirror that.
    render(() => {
      const hook = useMemory();
      m = hook;
      useEffect(() => void hook.actions.refreshContext(), [hook.peer, hook.session]);
    }, null);
    act(() => m!.setPeer("p1"));
    act(() => m!.setSession("sA"));
    expect(m!.loadingContext).toBe(true);
    act(() => m!.setWorkspace("ws2"));
    await flush();
    expect(m!.peer).toBeNull();
    expect(m!.loadingContext).toBe(false);
    expect(m!.loadingMessages).toBe(false);
  });
});

describe("useEvidenceReview: loading settles when a lane's selection is cleared", () => {
  type Props = { b: Bank; node: string | null; session: string | null };
  const BANK = { bank: "b1", token: "t1", workspace: "ws1" };

  test("deselecting the node and the session mid-read leaves every lane settled", async () => {
    const pending = parkedFetch();
    let e: ReturnType<typeof useEvidenceReview> | null = null;
    const view = render((p: Props) => void (e = useEvidenceReview(p.b, p.node, p.session)), { b: BANK, node: B, session: "sA" });
    expect(e!.lifecycle.loading).toBe(true);
    expect(e!.sessionLinks.loading).toBe(true);
    // Direct evidence lands, so the chained reverse-evidence read is in flight.
    await answerAll(pending, "getRevisionAssociations", { node_id: B, revision_id: "rev-B", links: [] });
    expect(e!.dependents.loading).toBe(true);
    view.rerender({ b: BANK, node: null, session: null });
    await flush();
    expect(e!.lifecycle.loading).toBe(false);
    expect(e!.association.loading).toBe(false);
    expect(e!.dependents.loading).toBe(false);
    expect(e!.sessionLinks.loading).toBe(false);
  });

  test("deselecting the node while its direct-evidence read is in flight leaves association settled", async () => {
    parkedFetch();
    let e: ReturnType<typeof useEvidenceReview> | null = null;
    const view = render((p: Props) => void (e = useEvidenceReview(p.b, p.node, p.session)), { b: BANK, node: B, session: null });
    expect(e!.association.loading).toBe(true);
    view.rerender({ b: BANK, node: null, session: null });
    await flush();
    expect(e!.association.loading).toBe(false);
  });

  test("moving to a node with no evidence while B's dependents are in flight leaves dependents settled", async () => {
    const pending = parkedFetch();
    let e: ReturnType<typeof useEvidenceReview> | null = null;
    const view = render((p: Props) => void (e = useEvidenceReview(p.b, p.node, p.session)), { b: BANK, node: B, session: null });
    await answerAll(pending, "getRevisionAssociations", { node_id: B, revision_id: "rev-B", links: [] });
    expect(e!.dependents.loading).toBe(true);
    view.rerender({ b: BANK, node: "nodeC", session: null });
    // C's direct evidence answers "none", so no reverse read is ever issued
    // for C -- nothing on that path would clear B's dependents flag.
    await answerAll(pending, "getRevisionAssociations", null);
    expect(e!.association.row).toBeNull();
    expect(e!.dependents.loading).toBe(false);
  });

  test("a scope switch while a trace lookup is in flight leaves traceLoading false", async () => {
    parkedFetch();
    let e: ReturnType<typeof useEvidenceReview> | null = null;
    const view = render((p: Props) => void (e = useEvidenceReview(p.b, p.node, p.session)), { b: BANK, node: null, session: null });
    act(() => e!.trace.setId("trace-1"));
    act(() => e!.trace.lookup());
    expect(e!.trace.loading).toBe(true);
    view.rerender({ b: { ...BANK, workspace: "ws2" }, node: null, session: null });
    await flush();
    expect(e!.trace.loading).toBe(false);
  });
});
