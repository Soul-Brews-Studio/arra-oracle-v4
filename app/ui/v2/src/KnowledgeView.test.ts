/** Failing-first RENDER test (#33 AC2 round 3, blocking finding 1). Below
 *  `lg` the Knowledge view stacks into one column. Round 2 kept `<main>` as
 *  `flex-1 overflow-y-auto` inside that column: a scroll container's automatic
 *  min-height is 0, so `<main>` absorbed ALL of the negative free space and
 *  the node view measured 6px tall at 375x812 and 147px at 830x859 (the
 *  NodeHead body 32px), while the page itself had nothing left to scroll.
 *
 * The layout this pins: below `lg` the view's root is the ONE scroll
 * container (the page scrolls), `<main>` is `flex-none` and not a scroll
 * container, so it is as tall as the node it shows; the bookmark rail is
 * capped so it cannot push the node off the first screen. From `lg` up the
 * three-column desktop layout (main as its own scroller) is unchanged.
 * Heights themselves are measured live -- see docs/overnight/UI-PROOF-ui-a11y.md
 * "Round 3". `bun test src/KnowledgeView.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeView } from "./KnowledgeView";

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

/** The class list of the first opening tag matching `open` (e.g. `<main`). */
function classesOf(html: string, open: RegExp): string[] {
  const m = html.match(open);
  expect(m).not.toBeNull();
  const tag = html.slice(m!.index!, html.indexOf(">", m!.index!));
  return (tag.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

const html = renderToStaticMarkup(
  createElement(KnowledgeView, {
    bank: { bank: "default", workspace: "default", token: "" },
    nodeId: null,
    onSelectNode: () => {},
  }),
);

describe("KnowledgeView stacked (<lg) layout: the page scrolls, main is not squashed", () => {
  test("the view root is the single scroll container below lg, a row from lg", () => {
    const root = classesOf(html, /<div/);
    expect(root).toContain("overflow-y-auto");
    expect(root).toContain("flex-col");
    expect(root).toContain("lg:flex-row");
  });

  test("<main> is flex-none and NOT a scroll container below lg; it scrolls on its own only from lg", () => {
    const main = classesOf(html, /<main/);
    expect(main).toContain("flex-none");
    expect(main).not.toContain("flex-1");
    expect(main).not.toContain("overflow-y-auto");
    expect(main).toContain("lg:flex-1");
    expect(main).toContain("lg:overflow-y-auto");
    expect(main).toContain("lg:min-h-0");
  });

  test("the bookmark rail is height-capped below lg and uncapped from lg", () => {
    const rail = classesOf(html, /<aside/);
    expect(rail.some((c) => /^max-h-\[\d+vh\]$/.test(c))).toBe(true);
    expect(rail).toContain("lg:max-h-none");
    expect(rail).toContain("lg:w-64");
  });
});
