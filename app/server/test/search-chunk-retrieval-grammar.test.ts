/**
 * #30 retrieval (overnight R7 #30 part + R14) -- the PURE half: request
 * grammar of `searchKnowledgeKeyword` / `searchKnowledgeSemantic`, the
 * snippet window, and the chunk-boundary helpers of the keyword path (the
 * per-chunk pre-filter, the scan predicate, hit ordering). No dataset; the
 * persisted behaviour is `search-chunk-retrieval*.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { ContractError } from "../src/contracts/errors";
import {
  CHUNK_SIZE_CHARS,
  chunkMayHoldQuery,
  chunkSourceText,
  chunkText,
  DEFAULT_EMBEDDING_PROFILE,
  DEFAULT_SEARCH_LIMIT,
  groupKnowledgeHits,
  keywordScanPredicate,
  MAX_SEARCH_LIMIT,
  parseSearchKnowledgeKeyword,
  parseSearchKnowledgeSemantic,
  searchSnippet,
  SNIPPET_CODE_POINTS,
} from "../src/publication/search-chunk";
import { containsFolded } from "../src/fts/fts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const refused = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    const { code, path } = (error as ContractError).toJSON() as { code: string; path: string };
    return { code, path };
  }
  throw new Error("expected a refusal, got none");
};

describe("searchKnowledgeKeyword grammar", () => {
  const parse = (request: Record<string, unknown>) => parseSearchKnowledgeKeyword(bytes(request));

  test("workspace and query are required; limit is optional, bounded, and defaults", () => {
    expect(parse({ workspace_name: "alpha", query: "ลืม" })).toEqual({
      workspace_name: "alpha",
      query: "ลืม",
      limit: DEFAULT_SEARCH_LIMIT,
    });
    expect(DEFAULT_SEARCH_LIMIT).toBe(10);
    expect(MAX_SEARCH_LIMIT).toBe(50);
    expect(parse({ workspace_name: "alpha", query: "x", limit: null }).limit).toBe(DEFAULT_SEARCH_LIMIT);
    expect(parse({ workspace_name: "alpha", query: "x", limit: 50 }).limit).toBe(50);
    expect(refused(() => parse({ workspace_name: "alpha", query: "x", limit: 0 }))).toEqual({ code: "invalid_value", path: "/limit" });
    expect(refused(() => parse({ workspace_name: "alpha", query: "x", limit: 51 }))).toEqual({ code: "invalid_value", path: "/limit" });
    expect(refused(() => parse({ workspace_name: "alpha", query: "x", limit: "5" }))).toEqual({ code: "invalid_type", path: "/limit" });
    expect(refused(() => parse({ workspace_name: "alpha", query: "x", limit: 1.5 }))).toEqual({ code: "invalid_type", path: "/limit" });
    expect(refused(() => parse({ workspace_name: "alpha" }))).toEqual({ code: "missing_field", path: "/query" });
    expect(refused(() => parse({ query: "x" }))).toEqual({ code: "missing_field", path: "/workspace_name" });
  });

  test("closed keys: keyword search takes no profile and no stray field", () => {
    expect(refused(() => parse({ workspace_name: "alpha", query: "x", embedding_profile: "all-minilm" }))).toEqual({
      code: "unexpected_field",
      path: "/embedding_profile",
    });
    expect(refused(() => parse({ workspace_name: "alpha", query: "x", mode: "fts" }))).toEqual({ code: "unexpected_field", path: "/mode" });
  });

  test("the query is kept verbatim, but a blank or oversized query is refused", () => {
    expect(parse({ workspace_name: "alpha", query: " ลืม " }).query).toBe(" ลืม ");
    expect(refused(() => parse({ workspace_name: "alpha", query: "" }))).toMatchObject({ path: "/query" });
    expect(refused(() => parse({ workspace_name: "alpha", query: "  \n\t" }))).toEqual({ code: "invalid_value", path: "/query" });
    expect(refused(() => parse({ workspace_name: "alpha", query: 7 }))).toEqual({ code: "invalid_type", path: "/query" });
    expect(refused(() => parse({ workspace_name: "alpha", query: "ก".repeat(1366) }))).toEqual({ code: "limit_exceeded", path: "/query" });
    expect(parse({ workspace_name: "alpha", query: "ก".repeat(1365) }).query).toHaveLength(1365);
  });
});

describe("searchKnowledgeSemantic grammar", () => {
  const parse = (request: Record<string, unknown>) => parseSearchKnowledgeSemantic(bytes(request));

  test("the profile is optional; absent means the query embedder's own profile, resolved by the service", () => {
    expect(DEFAULT_EMBEDDING_PROFILE).toBe("all-minilm");
    expect(parse({ workspace_name: "alpha", query: "q" })).toEqual({
      workspace_name: "alpha",
      query: "q",
      limit: DEFAULT_SEARCH_LIMIT,
      embedding_profile: null,
    });
    expect(parse({ workspace_name: "alpha", query: "q", embedding_profile: null }).embedding_profile).toBeNull();
    expect(parse({ workspace_name: "alpha", query: "q", embedding_profile: "profile-b", limit: 3 })).toMatchObject({
      embedding_profile: "profile-b",
      limit: 3,
    });
  });

  test("the profile is a stored profile NAME, not the index-time {name, dims} object", () => {
    expect(refused(() => parse({ workspace_name: "alpha", query: "q", embedding_profile: { name: "all-minilm", dims: 384 } }))).toEqual({
      code: "invalid_type",
      path: "/embedding_profile",
    });
    expect(refused(() => parse({ workspace_name: "alpha", query: "q", embedding_profile: "" }))).toMatchObject({ path: "/embedding_profile" });
    expect(refused(() => parse({ workspace_name: "alpha", query: "q", vector: [] }))).toEqual({ code: "unexpected_field", path: "/vector" });
  });
});

describe("searchSnippet", () => {
  const codePoints = (text: string) => [...text].length;

  test("a short chunk is returned whole", () => {
    expect(searchSnippet("บันทึก\n\nฉันหลงลืมกุญแจ", "ลืม")).toBe("บันทึก\n\nฉันหลงลืมกุญแจ");
  });

  test("a long chunk is windowed around the first case-folded occurrence", () => {
    const text = `${"x".repeat(500)}หลงลืม${"y".repeat(500)}`;
    const snippet = searchSnippet(text, "ลืม");
    expect(snippet).toContain("หลงลืม");
    expect(codePoints(snippet)).toBe(SNIPPET_CODE_POINTS);
    const english = searchSnippet(`${"a ".repeat(300)}The QUICK brown fox${" b".repeat(300)}`, "quick");
    expect(english).toContain("QUICK");
  });

  test("windows count code points, so an astral character is never split", () => {
    const snippet = searchSnippet("😀".repeat(300), null);
    expect(codePoints(snippet)).toBe(SNIPPET_CODE_POINTS);
    expect(snippet).toBe("😀".repeat(SNIPPET_CODE_POINTS));
  });

  test("no occurrence (semantic) means the chunk's opening window", () => {
    expect(searchSnippet(`${"z".repeat(400)}`, null)).toBe("z".repeat(SNIPPET_CODE_POINTS));
    expect(searchSnippet(`abc${"z".repeat(400)}`, "absent")).toBe(`abc${"z".repeat(SNIPPET_CODE_POINTS - 3)}`);
  });
});

describe("chunkMayHoldQuery: the per-chunk pre-filter is exact about every way a chunk can hold part of an occurrence", () => {
  // Chunks of 6 code units, so a 6-unit chunk has a seam after it.
  const may = (chunk: string, index: number, query: string) => chunkMayHoldQuery(chunk, BigInt(index), query, 6);

  test("whole, cut at the end, cut at the start, or wholly inside a longer query", () => {
    expect(may("ฉันหลงลืมกุญแจ", 0, "ลืม")).toBe(true);
    expect(may("aaaaหล", 0, "หลงลืม")).toBe(true); // full length, ends with a prefix
    expect(may("งลืม t", 1, "หลงลืม")).toBe(true); // after a seam, starts with a suffix
    expect(may("cdefgh", 1, "abcdefghij")).toBe(true); // between two seams, inside
    expect(may("xx  QU", 0, "quick")).toBe(true); // case-folded
    expect(chunkMayHoldQuery("a".repeat(998) + "หล", 0n, "หลงลืม")).toBe(true); // the real chunk size
  });

  test("a chunk that only shares a trigram with the query is dropped", () => {
    expect(may("ฉันหลงลืมกุญแจไว้ที่บ้าน", 0, "หลงทาง")).toBe(false);
    expect(may("ทางxyq", 1, "zหลง")).toBe(false);
  });

  test("only a real seam counts: no seam before chunk 0, none after a short (last) chunk", () => {
    expect(may("aหล", 0, "หลงลืม")).toBe(false); // short, so the last chunk: the text ends here
    expect(may("aaaaหล", 0, "หลงลืม")).toBe(true); // the same ending on a full chunk: a seam follows
    expect(may("งลืม t", 0, "หลงลืม")).toBe(false); // chunk 0 has nothing before it
    expect(may("ลืม x", 1, "หลงลืม")).toBe(true); // a short last chunk still has a seam before it
  });

  test("final sigma: a chunk-local fold never hides an occurrence the whole text holds", () => {
    // "ΟΔΟΣ" alone folds its last Σ to final ς; followed by Α it folds to σ.
    expect(containsFolded("ΟΔΟΣΑΒ", "σα")).toBe(true);
    expect(chunkMayHoldQuery("ΟΔΟΣ", 0n, "σα", 4)).toBe(true);
    expect(chunkMayHoldQuery("ΑΒ", 1n, "σα", 4)).toBe(true);
  });

  test("property: every chunk an occurrence spans passes, for every cut position", () => {
    const query = "หลงลืม";
    for (let pad = 0; pad < 12; pad++) {
      const text = `${"x".repeat(pad)}${query}${"y".repeat(7)}`;
      const chunks = chunkText(text, 5);
      let at = 0;
      const start = text.indexOf(query);
      for (const [index, chunk] of chunks.entries()) {
        const [from, to] = [at, at + chunk.length];
        if (from < start + query.length && to > start) {
          expect(chunkMayHoldQuery(chunk, BigInt(index), query, 5), `pad ${pad} chunk ${JSON.stringify(chunk)}`).toBe(true);
        }
        at = to;
      }
    }
  });
});

describe("keywordScanPredicate: the scan reaches across chunk seams", () => {
  test("a short query adds a seam clause for every split, on non-first chunks only", () => {
    const predicate = keywordScanPredicate("หลง");
    expect(predicate).toContain("text ILIKE '%หลง%'");
    expect(predicate).toContain("chunk_index > 0");
    expect(predicate).toContain("text ILIKE 'ลง%'");
    expect(predicate).toContain("text ILIKE 'ง%'");
    expect(keywordScanPredicate("ก")).toBe("text ILIKE '%ก%' ESCAPE '\\'");
  });

  test("a long query is cut into pieces, one more than the chunk boundaries it can cross", () => {
    const query = "abcdefghij".repeat(110);
    const pieces = [...keywordScanPredicate(query).matchAll(/ILIKE '%([^%']*)%'/g)].map((m) => m[1]!);
    expect(pieces).toHaveLength(1 + Math.ceil((query.length - 1) / CHUNK_SIZE_CHARS));
    expect(pieces.join("")).toBe(query);
    for (const piece of pieces) expect([...piece].length).toBeGreaterThanOrEqual(3);
  });

  test("wildcards and quotes in a seam clause are escaped", () => {
    expect(keywordScanPredicate("5%'")).toContain("text ILIKE '''%' ESCAPE");
    expect(keywordScanPredicate("5%'")).toContain("text ILIKE '\\%''%' ESCAPE");
  });

  test("the chunk source text is the title, a blank line, and the body", () => {
    expect(chunkSourceText("t", "body")).toBe("t\n\nbody");
  });
});

describe("groupKnowledgeHits: unranked hits sort after every ranked one", () => {
  const chunk = (node: string, rank: number | null) => ({ id: `c-${node}`, node_id: node, revision_id: `r-${node}`, chunk_index: 0n, text: node, rank });
  const heads = new Map(["a", "b", "c", "d"].map((node) => [node, { revision_id: `r-${node}`, title: node }]));
  test("scores descending, then nulls by node id -- a total order", () => {
    const hits = groupKnowledgeHits([chunk("d", null), chunk("a", null), chunk("c", 1), chunk("b", 5)], heads, "descending", null);
    expect(hits.map((hit) => hit.node_id)).toEqual(["b", "c", "a", "d"]);
  });
});
