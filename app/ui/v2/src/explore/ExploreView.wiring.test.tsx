/** Failing-first (fix round, 2026-09-26, round 3). The round-2 verifier's
 *  blocking finding: the pure-function tests elsewhere in `state/` (
 *  `searchRouteState.test.ts`, `searchOutcomeView.test.ts`, ...) pin the
 *  LOGIC those functions compute, but nothing pinned that `ExploreView` and
 *  `useKnowledgeSearch` actually WIRE them together -- a revert at either
 *  call site left every one of those tests green.
 *
 * `react-dom/server`'s `renderToStaticMarkup` needs no jsdom (this repo has
 * none) and adds no dependency (`react-dom` is already installed): it runs
 * a component through one real render pass -- hooks' `useState` initializers
 * included -- without a DOM. It does NOT run effects, so this only reaches
 * bugs that are visible on the FIRST render: the routed `query`/`mode`
 * landing in `useKnowledgeSearch`'s initial state (W5) and in the rendered
 * search box (W2). `bun test src/explore/ExploreView.wiring.test.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useKnowledgeSearch } from "../state/useKnowledgeSearch";
import { ExploreView } from "./ExploreView";

const BANK = { bank: "b1", token: "t1", workspace: "w1" };

function noop() {}

function SearchHookHarness({ query, mode }: { query: string; mode: "keyword" | "semantic" }) {
  const search = useKnowledgeSearch(BANK, { query, mode }, noop);
  // Rendered as text, not just returned, so a mutant that drops the field
  // entirely (rather than just feeding it the wrong value) is visible too.
  return (
    <div data-query={search.query} data-mode={search.mode}>
      {JSON.stringify({ query: search.query, mode: search.mode })}
    </div>
  );
}

describe("useKnowledgeSearch: initial state comes from the routed query/mode (W5)", () => {
  test("mounting with a routed query/mode does not start from empty/keyword", () => {
    const html = renderToStaticMarkup(<SearchHookHarness query="ลืม" mode="semantic" />);
    expect(html).toContain("ลืม");
    expect(html).toContain("semantic");
    // The empty/default state a mutant that ignores `routed` would render
    // instead -- if this ALSO matched, the assertions above would not be
    // discriminating.
    expect(html).not.toContain('"query":""');
  });
});

describe("ExploreView: the routed query/mode land in the search box on mount (W2)", () => {
  test("mounting on the search tab with a routed query renders it into the input's value", () => {
    const html = renderToStaticMarkup(
      <ExploreView
        bank={BANK}
        selectedPeer={null}
        selectedSession={null}
        selectedNode={null}
        activeTab="search"
        onSelectPeer={noop}
        onSelectSession={noop}
        onSelectNode={noop}
        onTabChange={noop}
        onBack={noop}
        onOpenSearchHit={noop}
        searchQuery="ลืม"
        searchMode="semantic"
        onSearchChange={noop}
      />,
    );
    // The search box is a controlled `<input value={query} .../>` --
    // `renderToStaticMarkup` renders that as a real `value="..."` attribute.
    expect(html).toContain('value="ลืม"');
    // And the Semantic toggle button must be the one marked active, not the
    // keyword default a mutant that hardcodes `{ q: null, mode: null }` (or
    // otherwise ignores the routed props) would fall back to.
    const semanticButtonMatch = html.match(/<button[^>]*>semantic<\/button>/);
    expect(semanticButtonMatch).not.toBeNull();
    expect(semanticButtonMatch?.[0]).toContain("text-accent");
  });
});
