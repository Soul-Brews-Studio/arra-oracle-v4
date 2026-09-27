/** Failing-first (fix round, 2026-09-26): PR #110 follow-up #2. `formatRoute`
 *  is the pure WRITE half of `useRoute` (no `window` inside), so the Route ->
 *  URL mapping for the search tab's `q`/`mode` is testable without jsdom,
 *  which this repo does not have.
 *
 * Moved out of `useRoute.test.ts` (round-3 style finding) alongside the
 * `parseRoute`/`formatRoute` split out of `useRoute.ts` itself.
 *  `bun test src/state/formatRoute.test.ts`. */
import { describe, expect, test } from "bun:test";
import { formatRoute } from "./formatRoute";
import { parseRoute } from "./parseRoute";

describe("formatRoute: explore search state (q, mode)", () => {
  test("round-trips q and mode for the explore view", () => {
    const href = formatRoute({
      view: "explore",
      tab: "search",
      peer: null,
      session: null,
      node: null,
      q: "ลืม",
      mode: "semantic",
    });
    expect(href).toContain("tab=search");
    expect(parseRoute(href).q).toBe("ลืม");
    expect(parseRoute(href).mode).toBe("semantic");
  });

  test("omits q/mode for a view that does not carry them, same as node/tab", () => {
    const href = formatRoute({
      view: "knowledge",
      tab: null,
      peer: null,
      session: null,
      node: "n1",
      q: "should not leak",
      mode: "semantic",
    });
    expect(href).not.toContain("q=");
    expect(href).not.toContain("mode=");
  });
});
