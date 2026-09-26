/**
 * #30 retrieval (overnight R7 #30 part + R14) -- the PURE half: request
 * grammar of `searchKnowledgeKeyword` / `searchKnowledgeSemantic` and the
 * snippet window. No dataset; the persisted behaviour is
 * `search-chunk-retrieval.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { ContractError } from "../src/contracts/errors";
import {
  DEFAULT_EMBEDDING_PROFILE,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  parseSearchKnowledgeKeyword,
  parseSearchKnowledgeSemantic,
  searchSnippet,
  SNIPPET_CODE_POINTS,
} from "../src/publication/search-chunk";

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

  test("the profile is optional and defaults to the current default profile name", () => {
    expect(DEFAULT_EMBEDDING_PROFILE).toBe("all-minilm");
    expect(parse({ workspace_name: "alpha", query: "q" })).toEqual({
      workspace_name: "alpha",
      query: "q",
      limit: DEFAULT_SEARCH_LIMIT,
      embedding_profile: DEFAULT_EMBEDDING_PROFILE,
    });
    expect(parse({ workspace_name: "alpha", query: "q", embedding_profile: null }).embedding_profile).toBe(DEFAULT_EMBEDDING_PROFILE);
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
