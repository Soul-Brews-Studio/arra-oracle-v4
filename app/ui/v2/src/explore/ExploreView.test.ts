/** Failing-first RENDER test (#33 AC2 round 3, blocking finding 2). Once the
 *  peers/sessions lists stack above the detail pane (below `lg`), round 2's
 *  `DetailTabs` root was `min-h-0 flex-1` in a column whose lists were
 *  `shrink-0`: measured live, the detail pane was 38px at 830x859 and 0px at
 *  375x812, the Messages transcript viewport 24px. At 830 that was a
 *  regression from the `md:` layout it replaced.
 *
 * The layout this pins: below `lg` the lists are height-capped (their own
 * scroller), and the detail pane is a `shrink-0` region with a viewport-
 * relative height, so the page scrolls to it and it can never be squeezed to
 * nothing; from `lg` the detail pane is the row's `flex-1` again.
 * `bun test src/explore/ExploreView.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExploreView } from "./ExploreView";

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

function classesOf(html: string, open: RegExp): string[] {
  const m = html.match(open);
  expect(m).not.toBeNull();
  const tag = html.slice(m!.index!, html.indexOf(">", m!.index!));
  return (tag.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

const noop = () => {};
const html = renderToStaticMarkup(
  createElement(ExploreView, {
    bank: { bank: "default", workspace: "default", token: "" },
    selectedPeer: null,
    selectedSession: null,
    selectedNode: null,
    activeTab: "messages",
    onSelectPeer: noop,
    onSelectSession: noop,
    onSelectNode: noop,
    onTabChange: noop,
    onBack: noop,
    onOpenSearchHit: noop,
  }),
);

describe("ExploreView stacked (<lg) layout: the detail pane keeps a real height", () => {
  test("the detail pane is a named region, shrink-0 with a viewport height below lg, flex-1 from lg", () => {
    const pane = classesOf(html, /<section aria-label="Explore detail"/);
    expect(pane).toContain("shrink-0");
    expect(pane.some((c) => /^h-\[\d+vh\]$/.test(c))).toBe(true);
    expect(pane.some((c) => /^min-h-\[\d+rem\]$/.test(c))).toBe(true);
    // the round-2 squash: an unprefixed flex-1 + min-h-0 in the stacked column
    expect(pane).not.toContain("flex-1");
    expect(pane).not.toContain("min-h-0");
    expect(pane).toContain("lg:flex-1");
    expect(pane).toContain("lg:min-h-0");
    expect(pane).toContain("lg:h-auto");
  });

  test("the peers/sessions column is height-capped below lg and uncapped from lg", () => {
    const lists = classesOf(html, /<div aria-label="Peers and sessions"/);
    expect(lists.some((c) => /^max-h-\[\d+vh\]$/.test(c))).toBe(true);
    expect(lists).toContain("lg:max-h-none");
    expect(lists).toContain("lg:w-64");
  });
});
