/** Failing-first tests for `searchState` (#33 search box: "clear states" --
 *  empty query, no results, index_unavailable, model_unavailable). Pure, no
 *  DOM: `bun test src/state/searchState.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { searchState } from "./searchState";

const base = { query: "ลืม", loading: false, errorCode: null, hitCount: 0, scanReason: null } as const;

describe("searchState", () => {
  test("blank query (or all whitespace) is its own state before any request is made", () => {
    expect(searchState({ ...base, query: "" }).kind).toBe("empty_query");
    expect(searchState({ ...base, query: "   " }).kind).toBe("empty_query");
  });

  test("loading wins over any stale result/error from a previous query", () => {
    expect(searchState({ ...base, loading: true, errorCode: "forbidden" }).kind).toBe("loading");
  });

  test("model_unavailable (semantic, no/failing embedder) is its own distinct kind", () => {
    const view = searchState({ ...base, errorCode: "model_unavailable" });
    expect(view.kind).toBe("model_unavailable");
    if (view.kind === "model_unavailable") expect(view.detail).toMatch(/Ollama/);
  });

  test("any other governed error code is a generic error, not model_unavailable", () => {
    const view = searchState({ ...base, errorCode: "forbidden" });
    expect(view.kind).toBe("error");
    if (view.kind === "error") expect(view.title).toBe("forbidden");
  });

  test("zero hits with no scan reason is a plain no_results state", () => {
    const view = searchState({ ...base, hitCount: 0 });
    expect(view.kind).toBe("no_results");
    if (view.kind === "no_results") expect(view.scanNote).toBeNull();
  });

  test("index_unavailable (before the first indexRevisionChunks) is explained, not a bare empty list", () => {
    const view = searchState({ ...base, hitCount: 0, scanReason: "index_unavailable" });
    expect(view.kind).toBe("no_results");
    if (view.kind === "no_results") {
      expect(view.scanNote).toMatch(/index/i);
      expect(view.scanNote).toMatch(/indexRevisionChunks/);
    }
  });

  test("short_query still finds and reports hits via the scan fallback", () => {
    const view = searchState({ ...base, hitCount: 2, scanReason: "short_query" });
    expect(view.kind).toBe("results");
    if (view.kind === "results") expect(view.scanNote).toMatch(/short/i);
  });

  test("hits with no scan reason is the plain results state", () => {
    const view = searchState({ ...base, hitCount: 5 });
    expect(view.kind).toBe("results");
    if (view.kind === "results") expect(view.scanNote).toBeNull();
  });
});
