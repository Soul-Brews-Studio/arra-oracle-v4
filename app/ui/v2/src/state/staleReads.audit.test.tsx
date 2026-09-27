/** ui-stale audit (2026-09-27): the race `useKnowledge.refresh` had -- the
 *  LAST response to arrive wins, even when it answers a selection already
 *  left -- existed in two more fetch-in-effect hooks. Each test parks every
 *  request, then answers the NEWER one first and the older one last, and
 *  asserts the hook shows the newer answer. Unguarded, both showed the older.
 *
 *   - `useMemory.refreshMessages` / `refreshContext`: session A's transcript
 *     (or context) landing under session B after a fast switch.
 *   - `useListing`'s cursor list: the pre-toggle `listNodes` page landing
 *     after "show history" was switched on, so the toggle reads ON over the
 *     ordinary list.
 *
 * Same harness as `useKnowledge.publish.test.tsx` (react-dom/client into a
 * fake container, stubbed `fetch` / `localStorage` / `window`, all restored).
 * `bun test src/state/staleReads.audit.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { useListing } from "./useListing";
import { useMemory } from "./useMemory";

const BANK = { bank: "b1", token: "t1", workspace: "w1" };
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

function render<T>(useHook: () => T): () => T {
  let value: T | null = null;
  function Harness() {
    value = useHook();
    return null;
  }
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: null, ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} };
  root = createRoot(container as unknown as Element);
  act(() => root!.render(<Harness />));
  return () => value!;
}

describe("useMemory: a read for a session already left is discarded", () => {
  test("session A's transcript answering after B's leaves B's on screen", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory());
    act(() => m().setSession("sA"));
    act(() => m().setSession("sB"));
    await answer(pending, "listMessages", "sB", { rows: [{ id: "mB" }] });
    await answer(pending, "listMessages", "sA", { rows: [{ id: "mA" }] });
    expect(m().messages.map((r) => r.id)).toEqual(["mB"]);
    expect(m().loadingMessages).toBe(false);
  });

  test("session A's context answering after B's leaves B's on screen", async () => {
    const pending = parkedFetch((b) => String(b.session_name ?? ""));
    const m = render(() => useMemory());
    act(() => m().setPeer("p1"));
    act(() => m().setSession("sA"));
    await act(async () => void m().actions.refreshContext());
    act(() => m().setSession("sB"));
    await act(async () => void m().actions.refreshContext());
    await answer(pending, "getContext", "sB", { items: [{ id: "cB" }] });
    await answer(pending, "getContext", "sA", { items: [{ id: "cA" }] });
    expect((m().context as unknown as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(["cB"]);
  });
});

describe("useListing: a page for a superseded load is discarded", () => {
  test("the pre-toggle listNodes page answering last does not replace the history view", async () => {
    const pending = parkedFetch((b) => String(b.include_inactive ?? ""));
    const l = render(() => useListing(BANK));
    act(() => l().setIncludeInactive(true));
    await answer(pending, "listNodes", "true", { rows: [{ id: "with-history" }], next_after_id: null });
    await answer(pending, "listNodes", "false", { rows: [{ id: "ordinary" }], next_after_id: "cursor-from-old-load" });
    const nodes = l().nodes.state;
    expect(nodes.rows.map((r) => r.id)).toEqual(["with-history"]);
    expect(nodes.hasNext).toBe(false);
  });
});
