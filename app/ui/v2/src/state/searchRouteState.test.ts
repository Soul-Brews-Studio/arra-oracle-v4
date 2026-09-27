/** Failing-first (fix round, 2026-09-26): PR #110 follow-up #2.
 *  `bun test src/state/searchRouteState.test.ts`. */
import { describe, expect, test } from "bun:test";
import { searchRouteState } from "./searchRouteState";

describe("searchRouteState", () => {
  test("restores a persisted query and mode from the route", () => {
    expect(searchRouteState({ q: "ลืม", mode: "semantic" })).toEqual({ query: "ลืม", mode: "semantic" });
  });

  test("a route with neither param starts an empty keyword search", () => {
    expect(searchRouteState({ q: null, mode: null })).toEqual({ query: "", mode: "keyword" });
  });

  test("an unrecognised mode value falls back to keyword instead of propagating a bad string", () => {
    expect(searchRouteState({ q: "x", mode: "bogus" })).toEqual({ query: "x", mode: "keyword" });
  });
});
