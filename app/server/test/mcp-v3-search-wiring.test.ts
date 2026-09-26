// Slice V5 wiring, no dataset (docs/overnight/V3-PARITY.md §2.1 rule c, §3 A1;
// DECISIONS.md R18 V5). Written BEFORE the fix, against two defects:
//
//  1. The catalogue named the K1 methods as V3-PARITY §5 first DESIGNED them,
//     `searchChunksKeyword`/`searchChunksSemantic`. #30 shipped them as
//     `searchKnowledgeKeyword`/`searchKnowledgeSemantic` (search-chunk-v1.md
//     §13), so rule (c) never held and oracle_search stayed hidden forever.
//  2. `kb()` pins ONE bundle per tool call, opened for the tool's action. The
//     #30 searches live on the READER only (the query embedder is reader
//     composition), so a content:write tool that searches -- oracle_search_chain
//     -- would reach the writer bundle and hit the registry's "requires the
//     reader bundle" backstop on every call.

import { describe, expect, test } from "bun:test";
import { KNOWLEDGE_METHODS, type KnowledgeBundle } from "../src/knowledge/registry";
import type { KnowledgeAccess } from "../src/knowledge/transport";

const V5 = ["oracle_search", "oracle_ask", "oracle_search_chain"];

describe("the catalogue names the real #30 search methods", () => {
  test("no tool names a method the registry never had, and every V5 requirement is registered", async () => {
    const { V3_CATALOGUE } = await import("../src/mcp/legacy-v3/catalogue");
    const all = V3_CATALOGUE.flatMap((t) => [...t.uses, ...t.requires]);
    expect(all).not.toContain("searchChunksKeyword");
    expect(all).not.toContain("searchChunksSemantic");
    for (const name of V5) {
      const spec = V3_CATALOGUE.find((t) => t.name === name)!;
      expect(spec.requires.filter((m) => !(m in KNOWLEDGE_METHODS))).toEqual([]);
    }
    expect(V3_CATALOGUE.find((t) => t.name === "oracle_search")!.requires).toContain("searchKnowledgeKeyword");
    expect(V3_CATALOGUE.find((t) => t.name === "oracle_search_chain")!.requires).toContain("searchKnowledgeSemantic");
  });

  test("with a dataset configured, all three are available (listed) in this build", async () => {
    const { availability } = await import("../src/mcp/legacy-v3/availability");
    const configured: KnowledgeAccess = { getBundle: async () => ({}) as KnowledgeBundle };
    for (const name of V5) expect(availability(name, configured)).toEqual({ ok: true });
  });

  test("every recall tool's description states the D3 change", async () => {
    const { V3_TOOLS } = await import("../src/mcp/legacy-v3/catalogue");
    for (const name of V5) {
      const tool = V3_TOOLS.find((t) => t.name === name)!;
      expect(tool.description).toContain("Superseded and retired entries are excluded from recall");
    }
    expect(V3_TOOLS.find((t) => t.name === "oracle_search")!.description).toContain("fusion is not carried");
  });
});

describe("kb() reaches a reader-only method through the reader, whatever the tool's action", () => {
  const record = () => {
    const opened: string[] = [];
    const reader = { context: { searchKnowledgeSemantic: async () => ({ via: "reader" }) }, publication: {} };
    const writer = { context: { createTrace: async () => ({ via: "writer" }) }, publication: { publishRevision: async () => null } };
    const access: KnowledgeAccess = {
      getBundle: async (action) => {
        opened.push(action);
        return (action === "content:write" ? writer : reader) as unknown as KnowledgeBundle;
      },
    };
    return { opened, access };
  };
  const spec = (action: "content:read" | "content:write", uses: string[]) =>
    ({ name: "oracle_probe", action, uses, requires: [], description: "", inputSchema: { type: "object" } });

  test("the registry marks exactly the reader-facade searches and chat as reader-only reads", () => {
    const readerOnly = Object.entries(KNOWLEDGE_METHODS).filter(([, e]) => e.readerOnly === true).map(([m]) => m).sort();
    expect(readerOnly).toEqual(["answerChat", "getChatSettings", "searchKnowledgeKeyword", "searchKnowledgeSemantic"]);
    for (const m of readerOnly) expect(KNOWLEDGE_METHODS[m]!.action).toBe("content:read");
  });

  test("a content:write tool's search goes to the reader; its write still goes to the one pinned writer", async () => {
    const { createKb } = await import("../src/mcp/legacy-v3/createKb");
    const { opened, access } = record();
    const kb = createKb({ spec: spec("content:write", ["searchKnowledgeSemantic", "createTrace"]), bank: "bank-a", authority: { operator: false, peers: null }, access });
    expect(await kb("searchKnowledgeSemantic", { query: "q" })).toEqual({ via: "reader" });
    expect(await kb("createTrace", { id: "x" })).toEqual({ via: "writer" });
    expect(await kb("createTrace", { id: "y" })).toEqual({ via: "writer" });
    expect(opened).toEqual(["content:read", "content:write"]);
  });

  test("a content:read tool still opens one reader for everything", async () => {
    const { createKb } = await import("../src/mcp/legacy-v3/createKb");
    const { opened, access } = record();
    const kb = createKb({ spec: spec("content:read", ["searchKnowledgeSemantic"]), bank: "bank-a", authority: { operator: false, peers: null }, access });
    await kb("searchKnowledgeSemantic", { query: "q" });
    await kb("searchKnowledgeSemantic", { query: "r" });
    expect(opened).toEqual(["content:read"]);
  });
});
