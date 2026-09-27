/** Failing-first WIRING test (ui-prov fix round, 2026-09-27; verifier
 *  nonblocking finding): reverting only `KnowledgeView.tsx` to d949290 left
 *  the slice suite green, so nothing pinned that the real view mounts the
 *  freshness panel at all, nor that it feeds it the node's recall
 *  eligibility. This mounts the REAL `KnowledgeView` through
 *  `react-dom/client` on the shared fake DOM (`testing/installFakeDom.ts`, no
 *  new dependency), every knowledge method answered by a stubbed `fetch`.
 *
 * The node is the verifier's own counter-example: a RETIRED head whose one
 * chunk is `ready`. The panel must be on screen, read `indexed` for the
 * chunks, and say search does not return the node.
 * `bun test src/KnowledgeView.freshness.test.tsx`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KnowledgeView } from "./KnowledgeView";
import { findFakeElement } from "./testing/findFakeElement";
import { installFakeDom } from "./testing/installFakeDom";

const BANK = { bank: "b1", token: "t1", workspace: "w1" };
const NODE = "nodeRRRRRRRRRRRRRRRRR";
const REV = "revRRRRRRRRRRRRRRRRRR";
const PROFILE = "minilm-l6-v2/384";

const revision = {
  id: REV,
  node_id: NODE,
  revision_no: "1",
  title: "retired head",
  body: "body text",
  is_active: true,
  created_at: "2026-09-27T00:00:00.000Z",
};

const ANSWERS: Record<string, unknown> = {
  getAcceptedHead: { node: { id: NODE }, revision },
  listAcceptedHistory: { node: { id: NODE }, snapshot_head_revision_id: REV, revisions: [revision] },
  listLifecycleHistory: { rows: [], next_after_event_id: null },
  getSearchFreshness: {
    content: { nodes: 1, revisions: 1 },
    text_index: { indexed_rows: null, unindexed_rows: null },
    vectors: { profile_id: PROFILE, pending: 0, ready: 1, failed: 0, last_attempt_at: null, model_digest: { pinned: null, last_measured: null } },
  },
  listSearchChunks: [{ status: "ready", attempts: "1", error_code: null, last_attempt_at: null }],
  getRecallEligibility: { eligible: false, witness_event_id: "1", reasons: ["retired"] },
};

let uninstall: (() => void) | null = null;
let root: Root | null = null;
const savedFetch = globalThis.fetch;
const savedStorage = (globalThis as { localStorage?: unknown }).localStorage;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  uninstall?.();
  uninstall = null;
  globalThis.fetch = savedFetch;
  (globalThis as { localStorage?: unknown }).localStorage = savedStorage;
});

describe("KnowledgeView mounts the search freshness panel for the node on screen", () => {
  test("a retired head with every chunk ready: panel present, chunks indexed, search says excluded", async () => {
    const dom = installFakeDom();
    uninstall = dom.uninstall;
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const asked: { method: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = decodeURIComponent(url.split("/").pop() ?? "");
      asked.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
      return method in ANSWERS
        ? new Response(JSON.stringify(ANSWERS[method]), { status: 200 })
        : new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }) as unknown as typeof fetch;

    root = createRoot(dom.container);
    await act(async () => {
      root!.render(<KnowledgeView bank={BANK} nodeId={NODE} onSelectNode={() => {}} />);
      for (let n = 0; n < 40; n++) await Promise.resolve();
    });
    await act(async () => {
      for (let n = 0; n < 40; n++) await Promise.resolve();
    });

    const panel = findFakeElement(dom.container, (el) => el.getAttribute("aria-label") === "search freshness");
    expect(panel).not.toBeNull();
    const state = findFakeElement(dom.container, (el) => el.getAttribute("data-freshness-state") !== null);
    expect(state).not.toBeNull();
    const label = findFakeElement(dom.container, (el) => el.getAttribute("data-freshness") === "label");
    expect(label?.textContent).toBe("indexed");
    const search = findFakeElement(dom.container, (el) => el.getAttribute("data-freshness") === "search");
    expect(search?.textContent).toContain("does not return this node");
    expect(search?.textContent).toContain("retired");
    expect(panel!.textContent).not.toMatch(/can both|find this revision/);

    // The reads are scoped to THIS node and ITS head revision.
    expect(asked.find((a) => a.method === "getRecallEligibility")?.body.node_id).toBe(NODE);
    expect(asked.find((a) => a.method === "listSearchChunks")?.body.revision_id).toBe(REV);
    expect(asked.find((a) => a.method === "listSearchChunks")?.body.embedding_profile).toBe(PROFILE);
  });
});
