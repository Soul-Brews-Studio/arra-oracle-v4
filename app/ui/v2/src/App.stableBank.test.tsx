/** Failing-first (ui-actions, 2026-09-27). The #118 verifier found
 *  `App.tsx:52`'s `useStableBank` call UNPINNED: `useKnowledge` wraps its own
 *  `bank` argument in a second `useStableBank` (see `useKnowledge.stale.test.tsx`'s
 *  "an equal bank does not refetch"), so removing App's own call is invisible
 *  from that hook alone. `useEvidenceReview` (wired into the Explore view's
 *  evidence tab) has NO such internal wrapping -- it reads `b` straight from
 *  its argument, and `refreshLifecycle`/`refreshAssociation` depend on `b` BY
 *  IDENTITY. An App render that rebuilds `bank` inline (App.tsx reverted to
 *  `{ bank: m.bank, token: m.token, workspace: m.workspace }`) hands
 *  `useEvidenceReview` a new object on every App render, which is exactly the
 *  second in-flight request `docs/overnight/UI-PROOF-ui-stale.md` measured.
 *
 * This test mounts the REAL `App` (via `installFakeDom`, no jsdom) on the
 * explore view with a node selected, lets the evidence lanes settle, forces
 * one more top-level render with NOTHING about the selection changed, and
 * asserts no new lifecycle/association request went out. Reverting
 * `App.tsx`'s `useStableBank` line alone must turn this red.
 * `bun test src/App.stableBank.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { installFakeDom } from "./testing/installFakeDom";
import { App } from "./App";

let root: Root | null = null;
let uninstall: (() => void) | null = null;
// `installFakeDom` restores the DOM globals it replaced; `fetch` and
// `localStorage` are replaced HERE, so they are put back here too (ui-reads2,
// r3 finding 5: a later file in the same `bun test` process inherited them).
let saved: { fetch: typeof fetch; localStorage: unknown } | null = null;

beforeEach(() => {
  saved = { fetch: globalThis.fetch, localStorage: (globalThis as Record<string, unknown>).localStorage };
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const fake = installFakeDom();
  uninstall = fake.uninstall;
  (globalThis as Record<string, unknown>).window = {
    ...(globalThis as unknown as { window: object }).window,
    location: { hash: "#/explore?node=node-1&tab=nodes", search: "", pathname: "/" },
    history: { pushState() {}, replaceState() {} },
  };
  root = createRoot(fake.container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  uninstall?.();
  uninstall = null;
  if (saved !== null) {
    globalThis.fetch = saved.fetch;
    (globalThis as Record<string, unknown>).localStorage = saved.localStorage;
    saved = null;
  }
});

/** A generously permissive body: every field any parser in this app reads
 *  off a `GET`-shaped response, defaulted to an empty/absent value. The
 *  point of this test is object identity and request COUNTS, not the
 *  rendered content, so "answers with nothing" for every method is enough. */
function genericBody(method: string): unknown {
  if (method === "health") return { status: "ok" };
  // `getRevisionAssociations` answers a bare row (not `{items}`/`{rows}`),
  // and `useEvidenceStatus` reads `.links`/`.terms` off it unconditionally
  // once it is non-null -- so this one method needs those two arrays present.
  if (method === "getRevisionAssociations") return { links: [], terms: [] };
  // Every other field this app's parsers read is defensively guarded
  // (`typeof`, `Array.isArray`, or `=== undefined`) -- EXCEPT the two "null
  // is a real answer, not absence" contracts (`getAcceptedHead`, `getTrace`),
  // which check `=== undefined` specifically and would misread a present
  // `null` as a found-but-empty row. Omitting every key (so those reads are
  // genuinely `undefined`) is the one body that is safe for every other
  // parser in this app.
  return {};
}

function countingFetch(): { calls: () => Record<string, number> } {
  const counts: Record<string, number> = {};
  globalThis.fetch = ((url: string) => {
    const method = url.split("/").pop() ?? "";
    counts[method] = (counts[method] ?? 0) + 1;
    return Promise.resolve(new Response(JSON.stringify(genericBody(method)), { status: 200 }));
  }) as unknown as typeof fetch;
  return { calls: () => ({ ...counts }) };
}

async function settle(rounds = 12): Promise<void> {
  await act(async () => {
    for (let n = 0; n < rounds; n++) await Promise.resolve();
  });
}

describe("App: the bank object handed to Explore/Knowledge is stable across an unrelated App render", () => {
  test("a top-level App re-render with no selection change issues no new evidence-review requests", async () => {
    const { calls } = countingFetch();
    act(() => root!.render(<App />));
    await settle();
    const before = calls();
    // A second top-level render of the SAME component, no props (App takes
    // none) and no state change of its own -- exactly what a health-poll or
    // any sibling `setState` elsewhere in App produces. `useStableBank`
    // memoizes on the bank/workspace/token STRINGS, so this must not move
    // `bank`'s identity and must not re-fire a single evidence-review fetch.
    act(() => root!.render(<App />));
    await settle();
    const after = calls();
    for (const method of ["listLifecycleHistory", "getRecallEligibility", "getRevisionAssociations"]) {
      expect(after[method] ?? 0).toBe(before[method] ?? 0);
    }
  });
});
