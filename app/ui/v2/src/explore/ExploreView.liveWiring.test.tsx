/** Failing-first (fix round 3b, 2026-09-27). Round-3 verifier's blocking
 *  findings: (1) `ExploreView.wiring.test.tsx`'s `renderToStaticMarkup`
 *  cannot run effects, so it cannot see the routed->box SYNC effect
 *  (`useKnowledgeSearch.ts`) or the write-back it races against -- W1/W4
 *  survive it untouched; (2) that race is real: Forward from
 *  `tab=nodes` (box "") to `tab=search&q=...` changes `activeTab` and the
 *  routed query in the same commit, and the old two-effect design (a sync
 *  effect in the hook, a write-back effect in `ExploreView`) each fired off
 *  a stale closure and undid the other's write, forever (measured live:
 *  63000+ renders / 2s, never settling).
 *
 * `react-dom/server`'s `renderToStaticMarkup` cannot reach either bug --
 * it renders once and never runs an effect. This file instead runs
 * `react-dom/client` for real, with a hand-built fake DOM (just enough
 * surface for React's DOM renderer to mount, commit and re-render: no
 * `document`/`window` from jsdom, no new dependency -- `react-dom` is
 * already installed). `act()` flushes the synchronous update chain a real
 * Back/Forward triggers. Against the pre-fix two-effect wiring this does
 * NOT converge: React logs "Maximum update depth exceeded" thousands of
 * times -- matching the verifier's live "63000+ renders/2s, never
 * settling". Round 3 let that spin inside `act()` forever (`timeout 30 bun
 * test` exited 124); round 4 caps harness renders at `MAX_RENDERS`, so the
 * same revert now FAILS in well under a second. The fixed wiring settles in
 * a handful of renders, which the assertions below pin a hard bound on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as React from "react";
// `act` from `react` itself (React 18.3+), not the deprecated
// `react-dom/test-utils` re-export, which printed a deprecation warning on
// every run (round-4 verifier finding).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SearchMode } from "../state/useKnowledgeSearch";
import { installFakeDom } from "../testing/installFakeDom";
import { findFakeElement } from "../testing/findFakeElement";
import { ExploreView } from "./ExploreView";

// The fake DOM this file used to define inline now lives in
// `testing/installFakeDom.ts`, shared with `ExploreView.writeBack.test.tsx`.

/** A settled Forward takes 1-3 harness renders; the round-3 loop took
 *  63000+ in 2s. Past this, the harness throws out of `act()` so a loop
 *  regression FAILS in bounded time instead of spinning inside `act()`'s
 *  synchronous flush forever (round-4 verifier finding: a reverted design
 *  made `bun test` never return, exit 124 under `timeout`). */
const MAX_RENDERS = 200;

const BANK = { bank: "b1", token: "t1", workspace: "w1" };

let uninstall: (() => void) | null = null;
let savedFetch: typeof fetch | undefined;
afterEach(() => {
  // Restores every DOM global AND `IS_REACT_ACT_ENVIRONMENT` (round-4
  // verifier finding: this file used to set that flag and never reset it).
  uninstall?.();
  uninstall = null;
  if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  savedFetch = undefined;
});

function noop() {}

/** Mounts the REAL `ExploreView`, driven by a `route`-shaped harness state
 *  standing in for `App.tsx` -- the actual site of the bug: an earlier
 *  version of this fix put the write-back in a `useEffect` HERE, in
 *  `ExploreView`, racing the routed-sync effect inside `useKnowledgeSearch`.
 *  A harness that calls `useKnowledgeSearch` directly (skipping
 *  `ExploreView`) cannot reach that effect at all -- confirmed empirically:
 *  it passes unchanged against the pre-fix `ExploreView`/hook pair. */
function Harness({
  onRender,
  onRouteReplace,
}: {
  /** Returns the running render count, checked against `MAX_RENDERS`. */
  onRender: () => number;
  onRouteReplace: (patch: { q: string | null; mode: string | null }) => void;
}) {
  if (onRender() > MAX_RENDERS) {
    throw new Error(`harness rendered more than ${MAX_RENDERS} times: the search sync/write-back is looping`);
  }
  const [route, setRoute] = React.useState<{ tab: string; q: string | null; mode: string | null }>({
    tab: "nodes",
    q: null,
    mode: null,
  });
  (globalThis as { __forward?: () => void }).__forward = () => {
    // The exact scenario from the verifier's Proof 1: `activeTab` and the
    // routed query change together, the way a browser Forward from
    // `#/explore?tab=nodes` to `#/explore?tab=search&q=...` lands both in
    // one `popstate`.
    setRoute({ tab: "search", q: "ลืม", mode: null });
  };
  return React.createElement(ExploreView, {
    bank: BANK,
    selectedPeer: null,
    selectedSession: null,
    selectedNode: null,
    activeTab: route.tab as never,
    onSelectPeer: noop,
    onSelectSession: noop,
    onSelectNode: noop,
    onTabChange: noop,
    onBack: noop,
    onOpenSearchHit: noop,
    searchQuery: route.q,
    searchMode: route.mode,
    onSearchChange: (q: string, mode: SearchMode) => {
      const patch = { q: q === "" ? null : q, mode };
      onRouteReplace(patch);
      setRoute((r) => ({ ...r, ...patch }));
    },
  });
}

describe("useKnowledgeSearch <-> route wiring: Forward into the search tab settles, never loops", () => {
  test("a routed query arriving together with a tab change converges in a bounded number of renders", () => {
    const dom = installFakeDom();
    uninstall = dom.uninstall;
    // `ExploreView` fetches through `useListing`/`useMemory`/`useKnowledge`/
    // `useEvidenceReview` on mount -- stubbed per this slice's "stubbed
    // models only" rule, and so a real network attempt in a DOM-less
    // process can't turn this test flaky.
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

    const container = dom.container;
    let renders = 0;
    const replaces: Array<{ q: string | null; mode: string | null }> = [];
    let root: Root | null = null;
    act(() => {
      root = createRoot(container);
      root.render(
        React.createElement(Harness, {
          onRender: () => ++renders,
          onRouteReplace: (patch) => replaces.push(patch),
        }),
      );
    });
    const rendersAfterMount = renders;
    const forward = (globalThis as { __forward?: () => void }).__forward;
    expect(typeof forward).toBe("function");

    // The bug (round-3 verifier, blocking #2): this `act()` either throws
    // React's "Maximum update depth exceeded" (the nested-update guard
    // catching an unbounded loop) or -- observed live outside `act`'s
    // synchronous guard -- simply never stops scheduling work. Either way,
    // the fixed wiring must settle in a handful of renders with the write-
    // back firing exactly once, for the query Forward actually carried.
    act(() => {
      forward?.();
    });

    const rendersForForward = renders - rendersAfterMount;
    // The bug looped this into the thousands (measured live: 63000+ in
    // 300ms); the fixed wiring settles in a couple of renders (one for
    // `setRoute`, one for the hook's routed-sync effect landing).
    expect(rendersForForward).toBeLessThan(10);
    // The route already carries the routed value -- the fix must NOT
    // re-emit a `replace` for a value that came FROM the route in the
    // first place. Any write here is the "transient history write" the
    // round-3 verifier flagged as a symptom of the same race.
    expect(replaces.length).toBe(0);

    // The box itself must land on the routed query, not the "" it raced
    // against -- a real controlled `<input>` inside the rendered tree,
    // found by tag since `ExploreView`'s own tree is not this test's to
    // shape.
    const input = findFakeElement(
      container,
      (el) => el.tagName === "INPUT" && el.getAttribute("placeholder") === "search knowledge (e.g. ลืม)",
    );
    expect(input).not.toBeNull();
    expect(input?.value).toBe("ลืม");

    act(() => {
      root?.unmount();
    });
  });
});

describe("useKnowledgeSearch: a local edit writes back to the route (W4)", () => {
  test("calling the hook's setQuery immediately reports the new query/mode to onRouteChange", async () => {
    const dom = installFakeDom();
    uninstall = dom.uninstall;
    const { useKnowledgeSearch } = await import("../state/useKnowledgeSearch");

    const container = dom.container;
    const calls: Array<[string, SearchMode]> = [];
    let setQuery: ((q: string) => void) | null = null;

    function HookHarness() {
      const search = useKnowledgeSearch(
        { bank: "b1", token: "t1", workspace: "w1" },
        { query: "", mode: "keyword" },
        (q, m) => calls.push([q, m]),
      );
      setQuery = search.setQuery;
      return null;
    }

    let root: Root | null = null;
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(HookHarness));
    });
    expect(calls).toEqual([]);

    // This is exactly what the search input's `onChange` does
    // (`KnowledgeSearchBox`: `onChange={(e) => onQuery(e.target.value)}`).
    // Mutant W4 (dropping the `onRouteChange` call from the wrapped
    // setter, reverting to a plain `setQueryState`) makes `calls` stay
    // empty here.
    act(() => {
      setQuery?.("ลืม");
    });
    expect(calls).toEqual([["ลืม", "keyword"]]);

    act(() => {
      root?.unmount();
    });
  });
});
