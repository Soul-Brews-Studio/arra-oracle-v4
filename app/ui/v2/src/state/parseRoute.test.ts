/** Failing-first (fix round, 2026-09-26): PR #110 follow-up #2. `parseRoute`
 *  is the pure READ half of `useRoute` (no `window` inside), so the URL ->
 *  Route mapping for the search tab's `q`/`mode` is testable without jsdom,
 *  which this repo does not have.
 *
 * Moved out of `useRoute.test.ts` (round-3 style finding) alongside the
 * `parseRoute`/`formatRoute` split out of `useRoute.ts` itself.
 *  `bun test src/state/parseRoute.test.ts`. */
import { describe, expect, test } from "bun:test";
import { parseRoute } from "./parseRoute";

describe("parseRoute: explore search state (q, mode)", () => {
  test("reads q and mode off an explore/search hash", () => {
    const route = parseRoute("#/explore?tab=search&q=%E0%B8%A5%E0%B8%B7%E0%B8%A1&mode=semantic");
    expect(route.view).toBe("explore");
    expect(route.tab).toBe("search");
    expect(route.q).toBe("ลืม");
    expect(route.mode).toBe("semantic");
  });

  test("leaves q/mode null when absent, same as the other optional params", () => {
    const route = parseRoute("#/explore?tab=search");
    expect(route.q).toBeNull();
    expect(route.mode).toBeNull();
  });

  test("falls back to overview for an unrecognised slug", () => {
    const route = parseRoute("#/no-such-view?q=x");
    expect(route.view).toBe("overview");
  });
});
