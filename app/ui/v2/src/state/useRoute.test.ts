/** Failing-first (fix round, 2026-09-26): PR #110 follow-up #2. `parse`/
 *  `format` are the pure halves of `useRoute` (no `window` inside either),
 *  so the URL <-> Route mapping for the search tab's `q`/`mode` is testable
 *  without jsdom, which this repo does not have.
 *  `bun test src/state/useRoute.test.ts`. */
import { describe, expect, test } from "bun:test";
import { format, parse } from "./useRoute";

describe("useRoute parse/format: explore search state (q, mode)", () => {
  test("parse reads q and mode off an explore/search hash", () => {
    const route = parse("#/explore?tab=search&q=%E0%B8%A5%E0%B8%B7%E0%B8%A1&mode=semantic");
    expect(route.view).toBe("explore");
    expect(route.tab).toBe("search");
    expect(route.q).toBe("ลืม");
    expect(route.mode).toBe("semantic");
  });

  test("parse leaves q/mode null when absent, same as the other optional params", () => {
    const route = parse("#/explore?tab=search");
    expect(route.q).toBeNull();
    expect(route.mode).toBeNull();
  });

  test("format round-trips q and mode for the explore view", () => {
    const href = format({
      view: "explore",
      tab: "search",
      peer: null,
      session: null,
      node: null,
      q: "ลืม",
      mode: "semantic",
    });
    expect(href).toContain("tab=search");
    expect(parse(href).q).toBe("ลืม");
    expect(parse(href).mode).toBe("semantic");
  });

  test("format omits q/mode for a view that does not carry them, same as node/tab", () => {
    const href = format({
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
