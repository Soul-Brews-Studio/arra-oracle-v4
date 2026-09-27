/** Failing-first RENDER test (#33 fix-round, blocking finding): `ListPanel`
 *  must not show the "no X — nothing on this page matches" empty state when
 *  a real error (401/403/etc.) is why the page is empty; it must show the
 *  error text instead. `renderToStaticMarkup`, no DOM, per
 *  `evidencePanels.test.ts`'s precedent. `bun test src/explore/ListPanel.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListPanel } from "./ListPanel";

const baseProps = {
  label: "peers",
  rows: [] as string[],
  rowKey: (r: string) => r,
  renderRow: (r: string) => r,
  selectedKey: null,
  onSelect: () => {},
  loading: false,
  supported: true,
  total: null,
  pageIndex: 0,
  hasNext: false,
  hasPrev: false,
  onNext: () => {},
  onPrev: () => {},
  onRefresh: () => {},
};

describe("ListPanel does not render a false-empty state over a real error", () => {
  test("a real error (e.g. a 401 hint) is shown, and the 'no peers' empty state is suppressed", () => {
    const html = renderToStaticMarkup(
      createElement(ListPanel, {
        ...baseProps,
        error: "No bearer token, or the token is not valid. Check the token field above and try again.",
      }),
    );
    expect(html).toContain("No bearer token");
    expect(html).not.toContain("no peers");
  });

  test("a genuinely empty page (no error) still shows the honest 'no peers' empty state", () => {
    const html = renderToStaticMarkup(createElement(ListPanel, { ...baseProps, error: null }));
    expect(html).toContain("no peers");
  });
});
