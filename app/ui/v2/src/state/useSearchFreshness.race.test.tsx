/** Failing-first (ui-prov fix round, 2026-09-27; verifier nonblocking
 *  finding): `useSearchFreshness`'s generation guard (`g === gen.current`)
 *  could be deleted with the slice suite still green. This drives the REAL
 *  hook through `react-dom/client` (the `useKnowledge.stale.test.tsx`
 *  harness: fake container, stubbed `fetch`, no new dependency) and lets the
 *  test, not the event loop, decide which revision's answers land last.
 *
 * Node A (head revA, every chunk `ready`) is on screen, then node B (head
 * revB, one chunk `pending`). B's answers land first; A's land after. The
 * view must stay on B's verdict, `pending` -- A's late `indexed` must neither
 * paint over it nor knock it back to `loading`.
 * `bun test src/state/useSearchFreshness.race.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import type { Bank } from "../api/memory";
import { searchFreshnessView } from "./searchFreshnessView";
import { useSearchFreshness } from "./useSearchFreshness";

const BANK: Bank = { bank: "b1", token: "t1", workspace: "w1" };
const PROFILE = "minilm-l6-v2/384";
const FRESHNESS = {
  content: { nodes: 2, revisions: 2 },
  text_index: { indexed_rows: null, unindexed_rows: null },
  vectors: { profile_id: PROFILE, pending: 1, ready: 1, failed: 0, last_attempt_at: null, model_digest: { pinned: null, last_measured: null } },
};
const chunk = (status: string) => ({ status, attempts: "0", error_code: null, last_attempt_at: null });

type Pending = { method: string; body: Record<string, unknown>; answer: (v: unknown, status?: number) => void };

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, act: g.IS_REACT_ACT_ENVIRONMENT, fetch: globalThis.fetch };
let root: Root | null = null;

beforeAll(() => {
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = { HTMLIFrameElement: class {} };
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  globalThis.fetch = saved.fetch;
});
afterAll(() => {
  g.window = saved.window;
  g.IS_REACT_ACT_ENVIRONMENT = saved.act;
});

function controllableFetch(): Pending[] {
  const pending: Pending[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Promise<Response>((resolve) => {
      pending.push({ method, body, answer: (v, status = 200) => resolve(new Response(JSON.stringify(v), { status })) });
    });
  }) as unknown as typeof fetch;
  return pending;
}

type H = ReturnType<typeof useSearchFreshness>;
function mount(initial: { node: string; rev: string }) {
  let h: H | null = null;
  function Harness({ node, rev }: { node: string; rev: string }) {
    h = useSearchFreshness(BANK, node, rev);
    return null;
  }
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: null, ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} };
  root = createRoot(container as unknown as Element);
  act(() => root!.render(<Harness {...initial} />));
  return {
    latest: () => h!,
    show: (p: { node: string; rev: string }) => act(() => root!.render(<Harness {...p} />)),
  };
}

/** Answer the parked request picked by `pick`, then let the hook's
 *  continuation (and the request it issues next) run. */
async function answer(pending: Pending[], pick: (p: Pending) => boolean, value: unknown, status = 200): Promise<void> {
  const i = pending.findIndex(pick);
  if (i < 0) throw new Error(`no such pending request; have ${pending.map((p) => p.method).join(", ")}`);
  const [p] = pending.splice(i, 1);
  await act(async () => {
    p!.answer(value, status);
    for (let n = 0; n < 10; n++) await Promise.resolve();
  });
}

describe("useSearchFreshness: a late answer for a revision already left is dropped", () => {
  test("A's answers landing after B's leave B's `pending` on screen", async () => {
    const pending = controllableFetch();
    const view = mount({ node: "nodeA", rev: "revA" });
    view.show({ node: "nodeB", rev: "revB" });

    // Two getSearchFreshness reads are parked: A's first, then B's. They carry
    // only workspace_name, so order is how the test tells them apart.
    const freshnessCalls = pending.filter((p) => p.method === "getSearchFreshness");
    expect(freshnessCalls.length).toBe(2);
    const [fA, fB] = freshnessCalls;

    // B lands completely first.
    await answer(pending, (p) => p === fB, FRESHNESS);
    await answer(pending, (p) => p.method === "getRecallEligibility" && p.body.node_id === "nodeB", { eligible: true, witness_event_id: "0", reasons: [] });
    await answer(pending, (p) => p.method === "listSearchChunks" && p.body.revision_id === "revB", [chunk("pending")]);
    expect(searchFreshnessView(view.latest().read).state).toBe("pending");

    // Then A's late answers.
    await answer(pending, (p) => p === fA, FRESHNESS);
    await answer(pending, (p) => p.method === "getRecallEligibility" && p.body.node_id === "nodeA", { eligible: false, witness_event_id: "1", reasons: ["retired"] });
    if (pending.some((p) => p.method === "listSearchChunks" && p.body.revision_id === "revA")) {
      await answer(pending, (p) => p.method === "listSearchChunks" && p.body.revision_id === "revA", [chunk("ready")]);
    }

    const v = searchFreshnessView(view.latest().read);
    expect(v.state).toBe("pending");
    expect(v.chunks).toEqual({ total: 1, pending: 1, ready: 0, failed: 0 });
    expect(v.search?.state).toBe("searchable");
  });

  test("the eligibility read is for the node on screen, and a failed one does not blank the chunk state", async () => {
    const pending = controllableFetch();
    const view = mount({ node: "nodeB", rev: "revB" });
    const eligibility = pending.find((p) => p.method === "getRecallEligibility");
    expect(eligibility?.body).toEqual({ workspace_name: "w1", node_id: "nodeB" });
    await answer(pending, (p) => p.method === "getSearchFreshness", FRESHNESS);
    await answer(pending, (p) => p.method === "listSearchChunks", [chunk("ready")]);
    // The eligibility read fails at the transport (HTTP 503).
    await answer(pending, (p) => p.method === "getRecallEligibility", { error: { code: "unavailable" } }, 503);
    const v = searchFreshnessView(view.latest().read);
    expect(v.state).toBe("indexed");
    expect(v.search?.state).not.toBe("searchable");
  });
});
