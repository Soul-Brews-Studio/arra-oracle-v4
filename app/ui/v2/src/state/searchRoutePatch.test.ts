/** Failing-first (fix round, 2026-09-26): PR #110 follow-up #2.
 *  `bun test src/state/searchRoutePatch.test.ts`. */
import { describe, expect, test } from "bun:test";
import { searchRoutePatch } from "./searchRoutePatch";

describe("searchRoutePatch", () => {
  test("carries the live query and mode", () => {
    expect(searchRoutePatch("ลืม", "semantic")).toEqual({ q: "ลืม", mode: "semantic" });
  });

  test("an empty query clears the q param instead of writing q= into the URL", () => {
    expect(searchRoutePatch("", "keyword")).toEqual({ q: null, mode: "keyword" });
  });
});
