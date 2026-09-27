/** Failing-first (fix round 3, 2026-09-27): the round-2 verifier showed the
 *  CALL SITE in `useKnowledge.publish` was still unpinned.
 *  `interpretPublishResult.test.ts` pins the pure decision, but reverting
 *  only `useKnowledge.ts` to 84061c9 (the `if (!result.ok)` check, no
 *  conflict branch) left `bun test src` green, and so did two call-site
 *  mutants: `interpretPublishResult({ ...result, body: null }, describe)`
 *  (a conflict resolves `true`, the caller navigates) and
 *  `setError(interpreted.error)` -> `setError(null)` (the refusal is silent).
 *
 * This drives the REAL hook: `react-dom/client` renders a harness into a
 * fake container object (no jsdom, no new dependency), `fetch` is stubbed,
 * and the taxonomy sits in a stubbed `localStorage` the way a seeded bank
 * has it. The harness captures `actions` and every rendered `error`, so the
 * assertions read what a user would see after the publish settles --
 * `renderToStaticMarkup` cannot, because on the server a setState after the
 * render is a no-op. The fake container renders nothing (the harness
 * returns `null`), so react-dom never creates a host node; it only needs
 * `addEventListener` for its root listeners and a `window` for the
 * selection bookkeeping around a commit. Both globals are put back after.
 * `bun test src/state/useKnowledge.publish.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { mintTaxonomyIds } from "../api/knowledge";
import { useKnowledge } from "./useKnowledge";

const BANK = { bank: "b1", token: "t1", workspace: "w1" };
const NODE = "nodeAAAAAAAAAAAAAAAAA";
const INPUT = {
  title: "t", body: "b", body_format: "text" as const, type_term: "note" as const,
  horizon: null, author_peer_name: null, session_name: null, change_reason: null, links: [],
};

type Seen = { error: string | null; selected: string | null; publishing: boolean };
type Actions = ReturnType<typeof useKnowledge>["actions"];

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, localStorage: g.localStorage, act: g.IS_REACT_ACT_ENVIRONMENT, fetch: globalThis.fetch };
let root: Root | null = null;

beforeAll(() => {
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = { HTMLIFrameElement: class {} };
  const store = new Map([[`arra-ui-v2-taxonomy:${BANK.bank}:${BANK.workspace}`, JSON.stringify(mintTaxonomyIds())]]);
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

/** `publishRevision` answers `publish`; every other method (the post-success
 *  `getAcceptedHead` refresh) answers `null`, the server's "no such node". */
function stubFetch(status: number, publishBody: unknown): string[] {
  const methods: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const method = url.split("/").pop() ?? "";
    methods.push(method);
    const body = method === "publishRevision" ? publishBody : null;
    return new Response(JSON.stringify(body), { status: method === "publishRevision" ? status : 200 });
  }) as unknown as typeof fetch;
  return methods;
}

async function mountAndPublish(): Promise<{ resolved: boolean; seen: Seen[] }> {
  const seen: Seen[] = [];
  let actions: Actions | null = null;
  function Harness() {
    const k = useKnowledge(BANK);
    actions = k.actions;
    seen.push({ error: k.error, selected: k.selected, publishing: k.publishing });
    return null;
  }
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: null, ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} };
  root = createRoot(container as unknown as Element);
  act(() => root!.render(<Harness />));
  let resolved = true;
  await act(async () => {
    resolved = await actions!.publish(INPUT, NODE, null);
  });
  return { resolved, seen };
}

describe("useKnowledge.publish: the call site acts on interpretPublishResult", () => {
  test("a 200 {outcome:'conflict', reason:'node_retired'} resolves false and shows the reason", async () => {
    const methods = stubFetch(200, { outcome: "conflict", reason: "node_retired" });
    const { resolved, seen } = await mountAndPublish();
    const last = seen[seen.length - 1];
    expect(resolved).toBe(false);
    expect(last.error).toBe("publish refused: this node was superseded or retired -- publishing here is disabled");
    // The navigation a refused publish must not do: no selection, no refresh.
    expect(last.selected).toBeNull();
    expect(methods).toEqual(["publishRevision"]);
    expect(last.publishing).toBe(false);
  });

  test("a non-2xx refusal (409 error envelope) resolves false and shows the server's code", async () => {
    const methods = stubFetch(409, { error: { code: "conflict", pointer: "/content/base_revision_id" } });
    const { resolved, seen } = await mountAndPublish();
    const last = seen[seen.length - 1];
    expect(resolved).toBe(false);
    expect(last.error).toBe("conflict at /content/base_revision_id");
    expect(last.selected).toBeNull();
    expect(methods).toEqual(["publishRevision"]);
  });

  test("control: a 200 {outcome:'accepted'} resolves true, clears the error and selects the node", async () => {
    const methods = stubFetch(200, { outcome: "accepted" });
    const { resolved, seen } = await mountAndPublish();
    const last = seen[seen.length - 1];
    expect(resolved).toBe(true);
    expect(last.error).toBeNull();
    expect(last.selected).toBe(NODE);
    // Proves the harness sees post-publish state at all: success refreshes.
    expect(methods).toContain("getAcceptedHead");
  });
});
