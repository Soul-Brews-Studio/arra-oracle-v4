/** Failing-first RENDER test (#33 AC2 round 3, nonblocking finding): Explore >
 *  Messages under a bad token or a diagnostics-only token showed only the bare
 *  code (`unauthenticated`/`forbidden`) while the two list panels directly
 *  above it showed the full `authErrorHint` sentence. `Transcript` is what that
 *  tab (and the messages view) renders, so the hint lives here, announced as
 *  an alert. `bun test src/components/Transcript.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { authErrorHint } from "../state/authErrorHint";
import { Transcript } from "./Transcript";

const render = (error: string | null) =>
  renderToStaticMarkup(
    createElement(Transcript, {
      messages: [],
      loading: false,
      error,
      selectedSession: "s1",
      highlighted: new Set<string>(),
      onLoadMore: () => {},
      hasMore: false,
    }),
  );

describe("Transcript explains a 401/403 the way the list panels do", () => {
  for (const code of ["unauthenticated", "forbidden"] as const) {
    test(`${code}: the bare code AND its hint, in a role=alert`, () => {
      const html = render(code);
      expect(html).toContain(code);
      expect(html).toContain(authErrorHint(code)!);
      expect(html).toMatch(/role="alert"/);
    });
  }

  test("an R3 peer-binding refusal with a pointer (`forbidden at /…`) still gets the forbidden hint", () => {
    // `useMemory`'s describe() appends the envelope pointer to the code.
    const html = render("forbidden at /peer_id");
    expect(html).toContain(authErrorHint("forbidden")!);
  });

  test("any other error keeps its text and gets no invented hint", () => {
    const html = render("HTTP 500");
    expect(html).toContain("HTTP 500");
    expect(html).not.toContain(authErrorHint("forbidden")!);
    expect(html).not.toContain(authErrorHint("unauthenticated")!);
  });
});
