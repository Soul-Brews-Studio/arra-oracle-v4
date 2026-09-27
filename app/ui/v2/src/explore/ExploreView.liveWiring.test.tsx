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
 * `document`/`window` from jsdom, no new dependency -- `react-dom` and its
 * bundled `test-utils` are already installed). `act()` flushes the
 * synchronous update chain a real Back/Forward triggers. Against the
 * pre-fix two-effect wiring this does NOT converge: React logs "Maximum
 * update depth exceeded" thousands of times and the process never returns
 * (confirmed by hand: `timeout 30 bun test` exits 124, 3090+ warnings) --
 * matching the verifier's live "63000+ renders/2s, never settling". The
 * fixed wiring settles in a handful of renders, which the assertions below
 * pin a hard bound on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
// `react-dom/test-utils` ships inside the already-installed `react-dom`
// package -- not a new dependency.
import { act } from "react-dom/test-utils";
import type { SearchMode } from "../state/useKnowledgeSearch";
import { ExploreView } from "./ExploreView";

// ---------------------------------------------------------------------
// Minimal fake DOM: only what `react-dom/client` touches to mount a tree,
// commit host-component updates, and run effects. No jsdom, no new
// dependency. Verified against a plain counter-effect component before use
// here (drives itself to a fixed point across several renders).
// ---------------------------------------------------------------------
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeType = 1;
  appendChild(child: FakeNode) {
    
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: FakeNode, ref: FakeNode | null) {
    child.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i === -1) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    return child;
  }
  removeChild(child: FakeNode) {
    const i = this.childNodes.indexOf(child);
    if (i !== -1) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  contains(): boolean {
    return true;
  }
  get ownerDocument() {
    return (globalThis as unknown as { document: unknown }).document;
  }
}
class FakeText extends FakeNode {
  nodeType = 3;
  constructor(public data: string) {
    super();
  }
  set textContent(v: string) {
    this.data = v;
  }
  get textContent() {
    return this.data;
  }
}
class FakeElement extends FakeNode {
  tagName: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<(e: unknown) => void>>();
  style: Record<string, string> = {};
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  // A real accessor pair, not an instance field: react-dom's controlled-
  // input value tracker (`inputValueTracking.js`) reads
  // `Object.getOwnPropertyDescriptor` off the node to install its own
  // wrapping descriptor, and only finds one for a property declared on the
  // PROTOTYPE (what `get`/`set` in a class body produce) -- a plain
  // `value = ""` field is an own-property with no descriptor to find,
  // silently defeating the tracker and leaving `.value` always "".
  #value = "";
  get value() {
    return this.#value;
  }
  set value(v: string) {
    this.#value = v;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  // `<select>` controlled-value reconciliation reads `.options` (an
  // `HTMLOptionElement` collection) to set each option's `.selected`.
  get options(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName === "OPTION");
  }
  selected = false;
  multiple = false;
  get textContent(): string {
    return this.childNodes.map((c) => (c as { textContent?: string }).textContent ?? "").join("");
  }
  set textContent(v: string) {
    // Matches native `Node.textContent = ""`: replaces ALL children, so an
    // empty string means NO children, not a child text node holding "".
    // React DOM's `clearContainer` sets this to "" before the first mount --
    // getting this wrong left a stray empty text node ahead of the real
    // render output, which is exactly the kind of fake-DOM bug this file's
    // header warns a hand-rolled harness is at risk of.
    this.childNodes = v === "" ? [] : [new FakeText(v)];
  }
}
class FakeDocument extends FakeElement {
  body: FakeElement;
  activeElement: FakeElement | null = null;
  constructor() {
    super("#document");
    this.nodeType = 9;
    this.body = new FakeElement("body");
  }
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  createTextNode(data: string) {
    return new FakeText(data);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag);
  }
  createComment(data: string) {
    return new FakeText(data);
  }
}

function installFakeDom() {
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const key of [
    "document",
    "window",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "HTMLOptionElement",
    "HTMLIFrameElement",
    "Node",
  ]) {
    saved[key] = g[key];
  }
  g.document = new FakeDocument();
  g.window = globalThis;
  g.navigator = { userAgent: "fake-dom-for-effects" };
  g.HTMLElement = FakeElement;
  g.HTMLInputElement = class extends FakeElement {};
  g.HTMLTextAreaElement = class extends FakeElement {};
  g.HTMLSelectElement = class extends FakeElement {};
  g.HTMLOptionElement = class extends FakeElement {};
  g.HTMLIFrameElement = class extends FakeElement {};
  g.Node = FakeNode;
  return () => {
    for (const key of Object.keys(saved)) g[key] = saved[key];
  };
}

const BANK = { bank: "b1", token: "t1", workspace: "w1" };

let uninstall: (() => void) | null = null;
let savedFetch: typeof fetch | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = null;
  if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
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
  onRender: () => void;
  onRouteReplace: (patch: { q: string | null; mode: string | null }) => void;
}) {
  onRender();
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

function findWhere(node: FakeNode, pred: (el: FakeElement) => boolean): FakeElement | null {
  if (node instanceof FakeElement && pred(node)) return node;
  for (const child of node.childNodes) {
    const found = findWhere(child, pred);
    if (found) return found;
  }
  return null;
}

describe("useKnowledgeSearch <-> route wiring: Forward into the search tab settles, never loops", () => {
  test("a routed query arriving together with a tab change converges in a bounded number of renders", () => {
    uninstall = installFakeDom();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // `ExploreView` fetches through `useListing`/`useMemory`/`useKnowledge`/
    // `useEvidenceReview` on mount -- stubbed per this slice's "stubbed
    // models only" rule, and so a real network attempt in a DOM-less
    // process can't turn this test flaky.
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

    const container = new FakeElement("div") as unknown as Element;
    let renders = 0;
    const replaces: Array<{ q: string | null; mode: string | null }> = [];
    let root: Root | null = null;
    act(() => {
      root = createRoot(container);
      root.render(
        React.createElement(Harness, {
          onRender: () => renders++,
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
    const input = findWhere(
      container as unknown as FakeNode,
      (el) => el.tagName === "INPUT" && el.getAttribute("placeholder") === "search knowledge (e.g. ลืม)",
    );
    expect(input).not.toBeNull();
    expect((input as unknown as { value: string }).value).toBe("ลืม");

    act(() => {
      root?.unmount();
    });
  });
});

describe("useKnowledgeSearch: a local edit writes back to the route (W4)", () => {
  test("calling the hook's setQuery immediately reports the new query/mode to onRouteChange", async () => {
    uninstall = installFakeDom();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { useKnowledgeSearch } = await import("../state/useKnowledgeSearch");

    const container = new FakeElement("div") as unknown as Element;
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
