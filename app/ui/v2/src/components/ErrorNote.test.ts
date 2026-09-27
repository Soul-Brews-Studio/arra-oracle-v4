/** Failing-first RENDER test (#33 AC2/R12 a11y slice, requirement 3):
 *  `ErrorNote` must show a clear, honest sentence for a 401/403 envelope, not
 *  just the bare code. `renderToStaticMarkup` per `evidencePanels.test.ts`'s
 *  precedent -- no DOM, no new dependency. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorNote } from "./ErrorNote";

describe("ErrorNote explains 401/403, not just the bare code", () => {
  test("unauthenticated (401) names the bad/missing token", () => {
    const html = renderToStaticMarkup(createElement(ErrorNote, { error: { code: "unauthenticated" } }));
    expect(html).toContain("unauthenticated");
    expect(html.toLowerCase()).toContain("token");
  });

  test("forbidden (403) names insufficient scope, distinctly from unauthenticated", () => {
    const html = renderToStaticMarkup(createElement(ErrorNote, { error: { code: "forbidden" } }));
    expect(html).toContain("forbidden");
    expect(html.toLowerCase()).toMatch(/permission|scope/);
  });

  test("an unrelated code is unaffected: no invented hint text", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorNote, { error: { code: "invalid_value", message: "bad field" } }),
    );
    expect(html).toContain("invalid_value");
    expect(html).toContain("bad field");
    expect(html.toLowerCase()).not.toContain("bearer token");
  });
});
