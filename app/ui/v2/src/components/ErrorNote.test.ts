/** Failing-first RENDER test (#33 AC2/R12 a11y slice, requirement 3):
 *  `ErrorNote` must show a clear, honest sentence for a 401/403 envelope, not
 *  just the bare code. `renderToStaticMarkup` per `evidencePanels.test.ts`'s
 *  precedent -- no DOM, no new dependency. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { authErrorHint } from "../state/authErrorHint";
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

  // #33 AC2 round 4 (nonblocking): `describe()` appends ` at <pointer>` to an
  // envelope that has one, and an R3 peer-binding refusal does. The Transcript
  // already keyed on the first word; this aside (`App.tsx`'s messageError)
  // dropped the hint for the very same string.
  test("a pointer-suffixed code in `message` (`forbidden at /peer_name`) still gets its hint", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorNote, { error: { code: "refused", message: "forbidden at /peer_name" } }),
    );
    expect(html).toContain("forbidden at /peer_name");
    expect(html).toContain(authErrorHint("forbidden")!);
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
