/** Failing-first RENDER test (#33 fix-round, nonblocking finding: "the
 *  responsive changes have no automated coverage at all"). Locks the
 *  breakpoint that stacks the navigator rail below the main content to `lg`
 *  (1024px) rather than `md` (768px) -- at a true 830 CSS px, `md:` classes
 *  are already active and the fixed-width aside eats most of the viewport,
 *  which is the defect this slice exists to fix (see `KnowledgeView.tsx`,
 *  `App.tsx` for the matching asides). `renderToStaticMarkup`, no DOM.
 *  `bun test src/components/SidebarShell.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarShell } from "./SidebarShell";

describe("SidebarShell stacks below lg (1024px), not md (768px)", () => {
  test("the expanded rail's width/border classes are lg:-scoped", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarShell, { collapsed: false, onToggle: () => {}, peer: null, session: null, children: null }),
    );
    expect(html).toContain("lg:w-60");
    expect(html).not.toMatch(/\bmd:w-60\b/);
    expect(html).not.toMatch(/\bmd:/);
  });
});
