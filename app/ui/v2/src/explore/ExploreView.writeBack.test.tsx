/** Failing-first (fix round 4, 2026-09-27). Round-4 verifier's blocking
 *  finding: the ORIGINAL W4 mutant -- `ExploreView` dropping its
 *  `onSearchChange` write-back at the CALL SITE (`useKnowledgeSearch(...,
 *  () => {})` instead of `..., onSearchChange)`, defined in
 *  `docs/overnight/UI-PROOF.md` under "Search polish, round 3") -- left all
 *  145 UI tests green. Round 3 pinned a W4 inside the hook instead, by
 *  mounting `useKnowledgeSearch` alone, which cannot see what `ExploreView`
 *  passes it. The feature still breaks under that mutant: typing never
 *  reaches the URL, so Back from the node view restores an empty box (PR
 *  #110 follow-up #2, the bug this slice exists to fix).
 *
 * This file mounts the REAL `ExploreView` through `react-dom/client` on the
 * shared fake DOM (`testing/installFakeDom.ts`), with a route-state harness
 * standing in for `App.tsx` that applies writes exactly the way `App.tsx`
 * does (`replace(searchRoutePatch(q, mode))`). It drives the real search
 * box's own `onChange`/`onClick` handlers and pins, per mutant:
 *   - W4 (call-site write-back dropped): typing writes `{q, mode}` out.
 *   - MM1 (`setMode` never calls `onRouteChange`): the mode toggle reaches
 *     the route.
 *   - MM2 (`setQuery` always writes `mode: "keyword"`): typing in semantic
 *     mode keeps `mode=semantic`.
 *   - MM3 (a routed empty `q` ignored by the sync effect): Back to an entry
 *     with no `q` empties the box. The round-3 test pinned only the Forward
 *     half.
 *
 * Every harness render is counted and capped (`MAX_RENDERS`): a sync/write
 * loop regression throws out of `act()` and FAILS in bounded time, instead
 * of spinning inside `act()`'s synchronous flush forever.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SearchMode } from "../state/useKnowledgeSearch";
import { searchRoutePatch } from "../state/searchRoutePatch";
import { installFakeDom } from "../testing/installFakeDom";
import { findFakeElement } from "../testing/findFakeElement";
import { ExploreView } from "./ExploreView";

const BANK = { bank: "b1", token: "t1", workspace: "w1" };
const PLACEHOLDER = "search knowledge (e.g. ลืม)";
/** A settled edit takes 1-3 harness renders; the round-3 loop took 63000+
 *  in 2s. Anything past this is a loop, reported as a failure. */
const MAX_RENDERS = 200;

type RouteSlice = { tab: string; q: string | null; mode: string | null };

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

function noop() {}

function Harness({
  control,
  onRouteReplace,
}: {
  control: { setRoute?: (r: RouteSlice) => void; renders: number };
  onRouteReplace: (patch: { q: string | null; mode: string | null }) => void;
}) {
  control.renders++;
  if (control.renders > MAX_RENDERS) {
    throw new Error(`harness rendered ${control.renders} times: the search sync/write-back is looping`);
  }
  const [route, setRoute] = React.useState<RouteSlice>({ tab: "search", q: null, mode: null });
  control.setRoute = setRoute;
  return (
    <ExploreView
      bank={BANK}
      selectedPeer={null}
      selectedSession={null}
      selectedNode={null}
      activeTab={route.tab as never}
      onSelectPeer={noop}
      onSelectSession={noop}
      onSelectNode={noop}
      onTabChange={noop}
      onBack={noop}
      onOpenSearchHit={noop}
      searchQuery={route.q}
      searchMode={route.mode}
      // Same wiring as `App.tsx`: `replace(searchRoutePatch(q, mode))`.
      onSearchChange={(q: string, mode: SearchMode) => {
        const patch = searchRoutePatch(q, mode);
        onRouteReplace(patch);
        setRoute((r) => ({ ...r, ...patch }));
      }}
    />
  );
}

/** Mounts `Harness` on a fresh fake DOM with `fetch` stubbed (every hook
 *  `ExploreView` owns fetches on mount -- "stubbed models only"). */
function mount() {
  const dom = installFakeDom();
  cleanup.push(dom.uninstall);
  const g = globalThis as { fetch?: typeof fetch };
  const savedFetch = g.fetch;
  // Never settles: this file pins route wiring, not fetch handling, and a
  // reply landing after `act()` returns would only add "not wrapped in
  // act(...)" noise from hooks unrelated to the search box.
  g.fetch = (() => new Promise<Response>(noop)) as unknown as typeof fetch;
  cleanup.push(() => {
    g.fetch = savedFetch;
  });

  const control: { setRoute?: (r: RouteSlice) => void; renders: number } = { renders: 0 };
  const replaces: Array<{ q: string | null; mode: string | null }> = [];
  let root: Root | null = null;
  act(() => {
    root = createRoot(dom.container);
    root.render(<Harness control={control} onRouteReplace={(p) => replaces.push(p)} />);
  });
  // Unmounted first (cleanup runs last-in, first-out), while the fake DOM
  // and `IS_REACT_ACT_ENVIRONMENT` are still installed.
  cleanup.push(() => act(() => root?.unmount()));

  // Re-found on every call: React replaces an element's props object on
  // each commit, so a handle from before an update holds stale handlers.
  const input = () => {
    const el = findFakeElement(dom.container, (e) => e.tagName === "INPUT" && e.getAttribute("placeholder") === PLACEHOLDER);
    if (el === null) throw new Error("search input not rendered");
    return el;
  };
  const modeButton = (m: SearchMode) => {
    const el = findFakeElement(dom.container, (e) => e.tagName === "BUTTON" && e.textContent === m);
    if (el === null) throw new Error(`mode button "${m}" not rendered`);
    return el;
  };
  const type = (text: string) => act(() => input().props.onChange({ target: { value: text } }));
  const click = (m: SearchMode) => act(() => modeButton(m).props.onClick({}));
  return { control, replaces, input, type, click };
}

describe("ExploreView search box -> route write-back (real ExploreView, real call site)", () => {
  test("W4: typing in the search box writes q/mode back through ExploreView's onSearchChange", () => {
    const h = mount();
    expect(h.replaces).toEqual([]);

    h.type("ลืม");

    // The call-site mutant (`useKnowledgeSearch(..., () => {})`) leaves this
    // empty: the box shows "ลืม" but the URL never learns it.
    expect(h.replaces).toEqual([{ q: "ลืม", mode: "keyword" }]);
    expect(h.input().value).toBe("ลืม");
  });

  test("MM1 + MM2: the mode toggle reaches the route, and typing in semantic mode keeps mode=semantic", () => {
    const h = mount();
    h.type("ลืม");
    h.click("semantic");
    expect(h.replaces.at(-1)).toEqual({ q: "ลืม", mode: "semantic" });

    h.type("ลืมไป");
    expect(h.replaces.at(-1)).toEqual({ q: "ลืมไป", mode: "semantic" });
    expect(h.replaces).toEqual([
      { q: "ลืม", mode: "keyword" },
      { q: "ลืม", mode: "semantic" },
      { q: "ลืมไป", mode: "semantic" },
    ]);
    // The routed-sync effect saw `mode=semantic` come back from the route
    // and must not have flipped the box back to keyword under MM2.
    expect(h.input().value).toBe("ลืมไป");
  });

  test("MM3: Back to an entry with no q empties the box, and never writes back", () => {
    const h = mount();
    h.type("ลืม");
    expect(h.input().value).toBe("ลืม");
    const writes = h.replaces.length;

    // Back (or an address-bar edit) landing on `#/explore?tab=search` with
    // no `q`: `useRoute` re-parses it to `q: null` while `ExploreView` stays
    // mounted.
    act(() => h.control.setRoute?.({ tab: "search", q: null, mode: null }));

    expect(h.input().value).toBe("");
    expect(h.replaces.length).toBe(writes);
    expect(h.control.renders).toBeLessThan(20);
  });
});
