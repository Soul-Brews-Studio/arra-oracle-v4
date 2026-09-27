/** Failing-first (ui-stale, 2026-09-27): a live verifier followed
 *  LifecycleBanner's "open successor" link from a superseded node B and got
 *  successor S2's id over B's title and body on 2 of 3 attempts. Two causes,
 *  one test each, both through the REAL hook:
 *
 *   1. `refresh` wrote whatever response arrived LAST. B's `getAcceptedHead`
 *      answering after S2's painted B under S2's id.
 *   2. `refresh` was keyed on the `Bank` object's identity, and App.tsx builds
 *      that object inline -- so every parent render refetched the node on
 *      screen, which is what put a second B request in flight to lose to.
 *
 * Same harness as `useKnowledge.publish.test.tsx`: `react-dom/client` renders
 * into a fake container (no jsdom, no new dependency), `fetch` and
 * `localStorage` are stubbed, and both globals are put back after.
 * `bun test src/state/useKnowledge.stale.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import type { Bank } from "../api/memory";
import { useKnowledge } from "./useKnowledge";

const BANK = { bank: "b1", token: "t1", workspace: "w1" };
const B = "nodeBBBBBBBBBBBBBBBBB";
const S2 = "nodeS2S2S2S2S2S2S2S2S";

type K = ReturnType<typeof useKnowledge>;
type Pending = { method: string; node: string; answer: () => void };

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, localStorage: g.localStorage, act: g.IS_REACT_ACT_ENVIRONMENT, fetch: globalThis.fetch };
let root: Root | null = null;

beforeAll(() => {
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = { HTMLIFrameElement: class {} };
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
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

const revision = (node: string) => ({
  id: `rev-${node}`, node_id: node, revision_no: "1", title: `title of ${node}`, body: `body of ${node}`,
});

/** Every request parks until the test answers it, so the test -- not the
 *  event loop -- decides which node's response lands last. */
function controllableFetch(): Pending[] {
  const pending: Pending[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const node = (JSON.parse(String(init?.body ?? "{}")) as { node_id?: string }).node_id ?? "";
    return new Promise<Response>((resolve) => {
      const body = method === "getAcceptedHead"
        ? { node: { id: node }, revision: revision(node) }
        : { node: { id: node }, snapshot_head_revision_id: `rev-${node}`, revisions: [revision(node)] };
      pending.push({ method, node, answer: () => resolve(new Response(JSON.stringify(body), { status: 200 })) });
    });
  }) as unknown as typeof fetch;
  return pending;
}

function mount(bank: () => Bank): { latest: () => K; rerender: () => void } {
  let k: K | null = null;
  function Harness({ b }: { b: Bank }) {
    k = useKnowledge(b);
    return null;
  }
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: null, ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} };
  root = createRoot(container as unknown as Element);
  act(() => root!.render(<Harness b={bank()} />));
  return { latest: () => k!, rerender: () => act(() => root!.render(<Harness b={bank()} />)) };
}

/** Answer the first parked request matching `method` + `node`, then let the
 *  hook's continuation (and any request it issues next) run. */
async function answer(pending: Pending[], method: string, node: string): Promise<void> {
  const i = pending.findIndex((p) => p.method === method && p.node === node);
  if (i < 0) throw new Error(`no pending ${method}(${node}); have ${pending.map((p) => `${p.method}(${p.node})`).join(", ")}`);
  const [p] = pending.splice(i, 1);
  await act(async () => {
    p!.answer();
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
}

describe("useKnowledge: a response for a node no longer selected is discarded", () => {
  test("B's head and history answering AFTER S2's leave S2 on screen", async () => {
    const pending = controllableFetch();
    const { latest } = mount(() => BANK);
    act(() => latest().setSelected(B));
    // The successor link: S2 is selected while B's head is still in flight.
    act(() => latest().setSelected(S2));
    await answer(pending, "getAcceptedHead", S2);
    await answer(pending, "listAcceptedHistory", S2);
    expect(latest().head?.revision?.node_id).toBe(S2);
    // Now the late B answers. Unguarded, it overwrites S2's head and then
    // issues (and lands) B's history too.
    await answer(pending, "getAcceptedHead", B);
    if (pending.some((p) => p.method === "listAcceptedHistory" && p.node === B)) {
      await answer(pending, "listAcceptedHistory", B);
    }
    const k = latest();
    expect(k.selected).toBe(S2);
    expect(k.head?.revision?.node_id).toBe(S2);
    expect(k.head?.revision?.title).toBe(`title of ${S2}`);
    expect(k.history.map((r) => r.node_id)).toEqual([S2]);
    expect(k.snapshotHead).toBe(`rev-${S2}`);
    expect(k.loading).toBe(false);
  });

  test("B's history answering after S2 was selected does not replace S2's", async () => {
    const pending = controllableFetch();
    const { latest } = mount(() => BANK);
    act(() => latest().setSelected(B));
    await answer(pending, "getAcceptedHead", B);
    // B's head landed and its history is in flight when S2 is selected.
    act(() => latest().setSelected(S2));
    await answer(pending, "getAcceptedHead", S2);
    await answer(pending, "listAcceptedHistory", S2);
    await answer(pending, "listAcceptedHistory", B);
    const k = latest();
    expect(k.head?.revision?.node_id).toBe(S2);
    expect(k.history.map((r) => r.node_id)).toEqual([S2]);
    expect(k.snapshotHead).toBe(`rev-${S2}`);
  });
});

describe("useKnowledge: an equal bank does not refetch", () => {
  test("re-rendering with a NEW but equal bank object issues no request", async () => {
    const pending = controllableFetch();
    // A fresh object per render, exactly what App.tsx's inline `bank={{...}}` did.
    const { latest, rerender } = mount(() => ({ ...BANK }));
    act(() => latest().setSelected(S2));
    await answer(pending, "getAcceptedHead", S2);
    await answer(pending, "listAcceptedHistory", S2);
    expect(pending).toEqual([]);
    rerender();
    rerender();
    rerender();
    expect(pending.map((p) => `${p.method}(${p.node})`)).toEqual([]);
    expect(latest().head?.revision?.node_id).toBe(S2);
  });
});
