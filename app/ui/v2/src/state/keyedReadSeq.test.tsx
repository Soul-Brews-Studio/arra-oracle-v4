/** ui-reads2 (2026-09-27): pins `useKeyedRead.land`'s SEQ matching through
 *  the real hooks. The r3 verifier found it unpinned: three mutants of the
 *  one line that clears the pending marker survived the whole suite --
 *
 *   M1  land() clears the marker unconditionally
 *   M3  land() clears it when the KEY matches (instead of the seq)
 *   M4  land() clears it when `p.seq === seq.current`
 *
 *  Each must turn a test here red:
 *   - same key, older lands first: the select-time read and a refresh for
 *     the SAME session are both in flight. The older one finishing must not
 *     clear the newer one's marker (M1, M3, M4), and must not paint its data.
 *   - cross key, A lands after B began: sA's read finishing must not clear
 *     sB's marker (M1, M4).
 *
 * Same harness as `staleClosure.test.tsx`; requests are answered by their
 * issue order, not just their method, so "older" and "newer" are exact.
 * `bun test src/state/keyedReadSeq.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import type { Bank } from "../api/memory";
import { useListing } from "./useListing";
import { useMemory } from "./useMemory";

type Sent = { n: number; method: string; body: Record<string, unknown>; answer: (body: unknown) => void };

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

/** Park every request, numbered in the order it was issued. */
function parkedFetch(): Sent[] {
  const pending: Sent[] = [];
  let n = 0;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Promise<Response>((resolve) => {
      pending.push({ n: n++, method, body, answer: (b) => resolve(new Response(JSON.stringify(b), { status: 200 })) });
    });
  }) as unknown as typeof fetch;
  return pending;
}

/** The parked `method` requests matching `where`, oldest first. */
function parked(pending: Sent[], method: string, where: (b: Record<string, unknown>) => boolean = () => true): Sent[] {
  return pending.filter((p) => p.method === method && where(p.body)).sort((a, b) => a.n - b.n);
}

async function answer(pending: Sent[], p: Sent | undefined, body: unknown): Promise<void> {
  if (p === undefined) throw new Error(`nothing to answer; have ${pending.map((q) => q.method).join(", ")}`);
  pending.splice(pending.indexOf(p), 1);
  await act(async () => {
    p.answer(body);
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
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

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const inSession = (s: string) => (b: Record<string, unknown>) => b.session_name === s;

describe("useKeyedRead seq matching: same key, the OLDER read lands first", () => {
  test("useMemory: select sA, refresh sA; the select-time read finishing leaves loading on and paints nothing", async () => {
    const pending = parkedFetch();
    const m = render(() => useMemory(), null);
    act(() => m.get().setSession("sA"));
    act(() => void m.get().actions.refreshMessages());
    const [older, newer] = parked(pending, "listMessages", inSession("sA"));
    expect(newer).toBeDefined();
    await answer(pending, older, { rows: [{ id: "old" }] });
    expect(m.get().loadingMessages).toBe(true); // M1, M3, M4 read false here
    expect(ids(m.get().messages)).toEqual([]);
    await answer(pending, newer, { rows: [{ id: "new" }] });
    expect(m.get().loadingMessages).toBe(false);
    expect(ids(m.get().messages)).toEqual(["new"]);
  });

  test("useListing: two refreshes of one workspace; the first finishing leaves loading on, the second's rows win", async () => {
    const pending = parkedFetch();
    const BANK: Bank = { bank: "b1", token: "t1", workspace: "w1" };
    const l = render((b: Bank) => useListing(b), BANK);
    act(() => l.get().peers.refresh());
    const [older, newer] = parked(pending, "listPeers");
    expect(newer).toBeDefined();
    await answer(pending, older, { rows: [{ name: "old" }], next_after_name: null, total: "1" });
    expect(l.get().peers.state.loading).toBe(true);
    expect(l.get().peers.state.rows).toEqual([]);
    await answer(pending, newer, { rows: [{ name: "new" }], next_after_name: null, total: "1" });
    expect(l.get().peers.state.loading).toBe(false);
    expect(l.get().peers.state.rows).toEqual([{ name: "new" }]);
  });
});

describe("useKeyedRead seq matching: cross key, A lands after B began", () => {
  test("useMemory: select sA then sB; sA's read finishing leaves sB loading", async () => {
    const pending = parkedFetch();
    const m = render(() => useMemory(), null);
    act(() => m.get().setSession("sA"));
    act(() => m.get().setSession("sB"));
    await answer(pending, parked(pending, "listMessages", inSession("sA"))[0], { rows: [{ id: "mA" }] });
    expect(m.get().loadingMessages).toBe(true); // M1, M4 read false here
    expect(ids(m.get().messages)).toEqual([]);
    await answer(pending, parked(pending, "listMessages", inSession("sB"))[0], { rows: [{ id: "mB" }] });
    expect(m.get().loadingMessages).toBe(false);
    expect(ids(m.get().messages)).toEqual(["mB"]);
  });
});
