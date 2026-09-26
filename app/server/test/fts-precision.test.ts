/**
 * R14 precision pins for the shared FTS module (`src/fts/`), below the
 * product path `fts-service.test.ts` drives.
 *
 * These are the decisions a later store (the #30 chunk index) inherits by
 * importing the same module, so each one is pinned where it is made: the one
 * options constant, the details comparison that decides a rebuild, the LIKE
 * escaping, and the bounded overfetch that substring verification relies on.
 * The overfetch is proven against a scripted fake table, because a BM25
 * ranking that buries a true match under N false positives is not something a
 * five-row real index can be made to produce on purpose.
 */

import { describe, expect, test } from "bun:test";
import {
  FTS_CANDIDATE_CEILING,
  FTS_CANDIDATE_FACTOR,
  FTS_INDEX_OPTIONS,
  FTS_MIN_QUERY_CODE_POINTS,
  ftsIndexConfig,
  ftsIndexMatches,
  likeContainsPredicate,
  substringSearch,
} from "../src/fts/fts";

const LIVE_TRIGRAM = {
  ascii_folding: true,
  base_tokenizer: "ngram",
  lower_case: true,
  max_ngram_length: 3,
  min_ngram_length: 3,
  prefix_only: false,
  remove_stop_words: false,
  stem: false,
  with_position: false,
};

describe("one options constant, one fresh index config per call", () => {
  test("FTS_INDEX_OPTIONS is exactly the R14 trigram and cannot be edited at runtime", () => {
    expect(FTS_INDEX_OPTIONS).toEqual({
      baseTokenizer: "ngram",
      ngramMinLength: 3,
      ngramMaxLength: 3,
      prefixOnly: false,
      stem: false,
      removeStopWords: false,
    });
    expect(Object.isFrozen(FTS_INDEX_OPTIONS)).toBe(true);
    expect(FTS_MIN_QUERY_CODE_POINTS).toBe(FTS_INDEX_OPTIONS.ngramMinLength);
  });

  test("each call builds a new native Index: one cannot be used twice (measured)", () => {
    expect(ftsIndexConfig()).not.toBe(ftsIndexConfig());
  });
});

describe("the live-details comparison that decides a rebuild", () => {
  test("a faithful trigram matches, whatever unrelated keys the engine adds", () => {
    expect(ftsIndexMatches(LIVE_TRIGRAM)).toBe(true);
  });

  test("any governed key that differs is a mismatch", () => {
    for (const [key, wrong] of [
      ["base_tokenizer", "icu"],
      ["min_ngram_length", 2],
      ["max_ngram_length", 4],
      ["prefix_only", true],
      ["stem", true],
      ["remove_stop_words", true],
    ] as const) {
      expect(ftsIndexMatches({ ...LIVE_TRIGRAM, [key]: wrong }), key).toBe(false);
    }
  });

  test("details that are missing or unparsed are never assumed to match", () => {
    for (const details of [undefined, null, "{\"base_tokenizer\":\"ngram\"}", {}, []]) {
      expect(ftsIndexMatches(details), JSON.stringify(details)).toBe(false);
    }
  });
});

describe("the short-query LIKE predicate", () => {
  test("%, _ and backslash are escaped, the quote is doubled, and the match is case-insensitive", () => {
    expect(likeContainsPredicate("content", "5%_'\\")).toBe("content ILIKE '%5\\%\\_''\\\\%' ESCAPE '\\'");
    expect(likeContainsPredicate("content", "ไป")).toBe("content ILIKE '%ไป%' ESCAPE '\\'");
  });
});

/** A scripted table: FTS returns `ranked` in order, the scan returns `scanned`. */
function fakeTable(ranked: Array<Record<string, unknown>>, scanned: Array<Record<string, unknown>> = []) {
  const calls: Array<{ kind: "fts" | "scan"; where: string; limit: number }> = [];
  const table = {
    query() {
      let kind: "fts" | "scan" = "scan";
      let where = "";
      let limit = Infinity;
      const builder = {
        fullTextSearch() {
          kind = "fts";
          return builder;
        },
        where(predicate: string) {
          where = predicate;
          return builder;
        },
        limit(n: number) {
          limit = n;
          return builder;
        },
        async toArray() {
          calls.push({ kind, where, limit });
          return (kind === "fts" ? ranked : scanned).slice(0, limit);
        },
      };
      return builder;
    },
  };
  return { table: table as never, calls };
}

const row = (id: string, content: string) => ({ id, content });
const decoys = (n: number) => Array.from({ length: n }, (_, i) => row(`decoy-${i}`, "หลงลืม")); // shares หลง only

describe("substring verification overfetches, bounded", () => {
  test("a true match ranked below the first fetch is still found: the fetch doubles until it is", async () => {
    const { table, calls } = fakeTable([...decoys(20), row("true", "เดินหลงทางในป่า")]);
    const result = await substringSearch(table, "content", "หลงทาง", "workspace_name = 'alpha'", 1);
    expect(result).toEqual({ match: "ngram", rows: [row("true", "เดินหลงทางในป่า")] });
    expect(calls.map((c) => c.limit)).toEqual([FTS_CANDIDATE_FACTOR, FTS_CANDIDATE_FACTOR * 2, FTS_CANDIDATE_FACTOR * 4, FTS_CANDIDATE_FACTOR * 8]);
    expect(calls.every((c) => c.kind === "fts" && c.where === "workspace_name = 'alpha'")).toBe(true);
  });

  test("the fetch never grows past the ceiling, even when no candidate verifies", async () => {
    const { table, calls } = fakeTable(decoys(FTS_CANDIDATE_CEILING + 10));
    const result = await substringSearch(table, "content", "หลงทาง", "workspace_name = 'alpha'", 10);
    expect(result).toEqual({ match: "ngram", rows: [] });
    expect(calls.at(-1)!.limit).toBe(FTS_CANDIDATE_CEILING);
    expect(Math.max(...calls.map((c) => c.limit))).toBe(FTS_CANDIDATE_CEILING);
  });

  test("an exhausted candidate list stops at once: no second fetch", async () => {
    const { table, calls } = fakeTable([row("a", "Brown Bear"), row("b", "rowing")]);
    const result = await substringSearch(table, "content", "ROW", "true", 10);
    expect(result.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(calls.length).toBe(1);
  });

  test("under three code points it never calls FTS: one scoped LIKE scan, limit applied, mode reported", async () => {
    const { table, calls } = fakeTable([], [row("x", "เราไปทะเล"), row("y", "ไปไหน")]);
    const result = await substringSearch(table, "content", "ไป", "workspace_name = 'alpha'", 1);
    expect(result).toEqual({ match: "substring_scan", rows: [row("x", "เราไปทะเล")] });
    expect(calls).toEqual([
      { kind: "scan", where: "(workspace_name = 'alpha') AND content ILIKE '%ไป%' ESCAPE '\\'", limit: 1 },
    ]);
  });

  test("code points, not UTF-16 units, decide the branch", async () => {
    // One astral code point is two UTF-16 units: still a short query.
    const { table, calls } = fakeTable([], []);
    expect((await substringSearch(table, "content", "😀x", "true", 5)).match).toBe("substring_scan");
    expect((await substringSearch(table, "content", "ลืม", "true", 5)).match).toBe("ngram");
    expect(calls.map((c) => c.kind)).toEqual(["scan", "fts"]);
  });
});
