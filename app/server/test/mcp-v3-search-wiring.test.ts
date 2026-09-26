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
//
// Fix round (an independent review refuted the slice), each written red first:
//  3. oracle_search_chain was admitted under content:write alone, yet its kb()
//     reached the reader and returned bank content: a read no other transport
//     grants a write-only principal. It now also needs content:read.
//  4. The per-word merge kept the hit from the word where an entry ranked best,
//     so an unrelated write elsewhere in the bank could change the snippet an
//     entry was shown with (the flaky acceptance step 30).
//  5. A trace write failing mid-chain hid the hop traces already written.

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

  test("the adapter's reader-only list is exactly the registry methods whose call refuses a writer bundle", async () => {
    const { READER_ONLY_METHODS } = await import("../src/mcp/legacy-v3/readerOnlyMethods");
    // Writer-shaped (publication.publishRevision is a function), no chat facade.
    const facade = new Proxy({}, { get: () => async () => "ok" });
    const writerShaped = new Proxy({}, { get: (_t, name) => (name === "chat" ? undefined : facade) }) as unknown as KnowledgeBundle;
    const refusing: string[] = [];
    for (const [method, entry] of Object.entries(KNOWLEDGE_METHODS)) {
      try {
        await entry.call(writerShaped, new Uint8Array(), { operator: false, peers: null });
      } catch (error) {
        if (/requires the reader/.test(String(error))) refusing.push(method);
      }
    }
    expect([...READER_ONLY_METHODS].sort()).toEqual(refusing.sort());
    expect(refusing.sort()).toEqual(["answerChat", "getChatSettings", "searchKnowledgeKeyword", "searchKnowledgeSemantic"]);
    for (const m of refusing) expect(KNOWLEDGE_METHODS[m]!.action).toBe("content:read");
  });

  test("a content:write tool's search goes to the reader; its write still goes to the one pinned writer", async () => {
    const { createKb } = await import("../src/mcp/legacy-v3/createKb");
    const { opened, access } = record();
    const reads = { ...spec("content:write", ["searchKnowledgeSemantic", "createTrace"]), alsoNeeds: ["content:read" as const] };
    const kb = createKb({ spec: reads, bank: "bank-a", authority: { operator: false, peers: null }, access });
    expect(await kb("searchKnowledgeSemantic", { query: "q" })).toEqual({ via: "reader" });
    expect(await kb("createTrace", { id: "x" })).toEqual({ via: "writer" });
    expect(await kb("createTrace", { id: "y" })).toEqual({ via: "writer" });
    expect(opened).toEqual(["content:read", "content:write"]);
  });

  test("a content:write tool that does not also need content:read never reaches a reader-only read", async () => {
    const { createKb } = await import("../src/mcp/legacy-v3/createKb");
    const { opened, access } = record();
    const kb = createKb({ spec: spec("content:write", ["searchKnowledgeSemantic", "createTrace"]), bank: "bank-a", authority: { operator: false, peers: null }, access });
    await expect(kb("searchKnowledgeSemantic", { query: "q" })).rejects.toThrow(/content:read/);
    expect(opened).toEqual([]);
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

describe("a write tool whose answer is bank content also needs content:read (exact grants, #31)", () => {
  test("every content:write tool reaching a reader-only read declares it, and the service admits by both", async () => {
    const { V3_CATALOGUE } = await import("../src/mcp/legacy-v3/catalogue");
    const { READER_ONLY_METHODS } = await import("../src/mcp/legacy-v3/readerOnlyMethods");
    const { toolAlsoNeeds } = await import("../src/auth/service.toolAlsoNeeds");
    const undeclared = V3_CATALOGUE.filter(
      (t) => t.action === "content:write" && t.uses.some((m) => READER_ONLY_METHODS.includes(m)) && !(t.alsoNeeds ?? []).includes("content:read"),
    );
    expect(undeclared.map((t) => t.name)).toEqual([]);
    expect(V3_CATALOGUE.find((t) => t.name === "oracle_search_chain")!.alsoNeeds).toEqual(["content:read"]);
    for (const t of V3_CATALOGUE) expect(toolAlsoNeeds(t.name, true)).toEqual(t.alsoNeeds ?? []);
    // Flag off, the family does not exist; base tools need nothing more.
    expect(toolAlsoNeeds("oracle_search_chain", false)).toEqual([]);
    expect(toolAlsoNeeds("kb_createTrace", true)).toEqual([]);
  });
});

describe("the per-word merge (v3's OR) shows an entry the same way whatever else the bank holds", () => {
  const hit = (node: string, snippet: string) => ({ node_id: node, revision_id: `${node}-r`, title: node, snippet, chunk_ids: [], match: "ngram" });
  test("the snippet is from the first query word the entry holds; its rank still uses its best position", async () => {
    const { mergeKeyword } = await import("../src/mcp/legacy-v3/search.mergeKeyword");
    const alone = mergeKeyword([{ term: "apfs", hits: [hit("X", "X at apfs")] }, { term: "disk", hits: [hit("X", "X at disk")] }]);
    // Another entry now outranks X for "apfs" only: X's best position comes from "disk".
    const crowded = mergeKeyword([
      { term: "apfs", hits: [hit("Y", "Y at apfs"), hit("X", "X at apfs")] },
      { term: "disk", hits: [hit("X", "X at disk")] },
    ]);
    expect(alone[0]).toMatchObject({ node_id: "X", snippet: "X at apfs", matched_terms: ["apfs", "disk"] });
    expect(crowded[0]).toMatchObject({ node_id: "X", snippet: "X at apfs", matched_terms: ["apfs", "disk"] });
    expect(crowded.map((h) => h.node_id)).toEqual(["X", "Y"]);
    // Equal word counts: best position first, then first seen.
    const ranked = mergeKeyword([{ term: "apfs", hits: [hit("W", "w"), hit("V", "v")] }, { term: "disk", hits: [hit("Z", "z")] }]);
    expect(ranked.map((h) => h.node_id)).toEqual(["W", "Z", "V"]);
  });
});

describe("oracle_search_chain: what it wrote stays visible", () => {
  const envelope = (code: string, path = "") =>
    Object.assign(new Error(code), { code, path, toJSON: () => ({ version: "arra-publication-error/v1", code, path, message: code }) });
  const head = (id: string) => ({ node: { id }, revision: { id: `${id}-rev`, title: id, body: `${id} body`, term_snapshot_json: "[]" }, lifecycle: null });
  const run = async (createTrace: (payload: Record<string, unknown>, n: number) => unknown, args: Record<string, unknown> = {}) => {
    const { oracle_search_chain } = await import("../src/mcp/legacy-v3/tools/oracle_search_chain");
    const traces: string[] = [];
    const kb = async (method: string, payload: Record<string, unknown>) => {
      if (method === "searchKnowledgeSemantic") {
        return { hits: ["A", "B", "C"].map((id) => ({ node_id: id, revision_id: `${id}-rev`, title: id, snippet: id, chunk_ids: [], distance: 0.1 })) };
      }
      if (method === "getAcceptedHead") return head(payload.node_id as string);
      if (method === "createTrace") {
        traces.push(payload.id as string);
        return createTrace(payload, traces.length - 1);
      }
      throw new Error(`unexpected ${method}`);
    };
    const context = { tool: "oracle_search_chain", bank: "bank-a", kb, assertedPeer: null, authority: { operator: false, peers: null }, indexProfile: {} } as never;
    try {
      return { value: await oracle_search_chain({ query: "seed", maxHops: 3, breadth: 1, ...args }, context), traces };
    } catch (error) {
      return { error: error as { code?: string; detail?: string; path?: string; toJSON?: () => unknown }, traces };
    }
  };

  test("a trace write failing after hop 0 is a kernel_error naming the hop traces already written", async () => {
    const got = await run((_p, n) => {
      if (n === 1) throw envelope("writer_unavailable");
      return { outcome: "created" };
    });
    expect(got.traces).toHaveLength(2);
    expect(got.error?.code).toBe("kernel_error");
    expect(got.error?.detail).toContain(got.traces[0]!);
    expect(got.error?.detail).not.toContain(got.traces[1]!);
    expect((got.error?.toJSON?.() as { v4_error?: { code?: string } }).v4_error?.code).toBe("writer_unavailable");
  });

  test("with an idempotency_key the hop trace ids are derived, and a key reused for another chain is refused", async () => {
    const created = await run(() => ({ outcome: "created" }), { idempotency_key: "k1" });
    const replayed = await run(() => ({ outcome: "already_satisfied" }), { idempotency_key: "k1" });
    const other = await run(() => ({ outcome: "created" }), { idempotency_key: "k2" });
    expect(created.traces).toHaveLength(3);
    expect(replayed.traces).toEqual(created.traces);
    expect((replayed.value as { traceIds: string[] }).traceIds).toEqual(created.traces);
    expect(other.traces[0]).not.toBe(created.traces[0]);
    const conflict = await run(() => ({ outcome: "conflict", reason: "payload" }), { idempotency_key: "k1" });
    expect(conflict.error).toMatchObject({ code: "semantic_refusal", path: "/idempotency_key" });
  });
});

describe("the embedder-down test is narrow", () => {
  test("only the kernel's model_unavailable with no path (the query embedder, R21) counts", async () => {
    const { isEmbedderDown } = await import("../src/mcp/legacy-v3/search.isEmbedderDown");
    const envelope = (code: string, path: string) => ({ code, path, toJSON: () => ({}) });
    expect(isEmbedderDown(envelope("model_unavailable", ""))).toBe(true);
    expect(isEmbedderDown(envelope("model_unavailable", "/query"))).toBe(false);
    // Pre-R21 the kernel said writer_unavailable for a down embedder. It no
    // longer does, so that code on a reader search is a real fault, not a
    // reason to fall back.
    expect(isEmbedderDown(envelope("writer_unavailable", ""))).toBe(false);
    expect(isEmbedderDown(envelope("invalid_value", ""))).toBe(false);
    expect(isEmbedderDown(new Error("model_unavailable"))).toBe(false);
    expect(isEmbedderDown(null)).toBe(false);
  });
  test("a model_unavailable that escapes a tool reads as a retryable outage, never as an input fault", async () => {
    const { fromKernel } = await import("../src/mcp/legacy-v3/compat-error.fromKernel");
    const v4 = { version: "arra-publication-error/v1", code: "model_unavailable", path: "", message: "chat model unavailable" };
    const wrapped = fromKernel("oracle_search", { code: "model_unavailable", path: "", toJSON: () => v4 }).toJSON();
    expect(wrapped.error).toBe("the model this call needs did not answer; retry");
    expect(wrapped.error).not.toContain("Invalid input");
    expect(wrapped.compat).toMatchObject({ code: "kernel_error", tool: "oracle_search", detail: "v4 answered model_unavailable" });
    expect(wrapped.v4_error).toEqual(v4);
  });
});
