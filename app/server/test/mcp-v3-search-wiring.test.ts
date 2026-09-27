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
//  6. #30 coverage amendment (search-chunk-v1.md §21, DECISIONS.md R21/R22):
//     `search.retrieve.ts` computed `saturated` only from its own 50-hit v3
//     window (`answer.hits.length >= SEARCH_WINDOW`), so a kernel
//     `coverage:"partial"` answer with FEWER than 50 hits -- the exact R22
//     residual, measured for real in
//     `search-chunk-retrieval-candidate-ceiling.test.ts` -- reached
//     `oracle_search`/`oracle_ask` looking complete (issue #30 coverage
//     amendment; verifier `.tmp/ac-search-accept-nonblocking.txt` finding 1).
//
// Second fix round (an independent re-verification refuted the round above's
// contract claim, and flagged an untested branch):
//  7. the OR semantics across fts terms -- `answers.some(...)`, a result is
//     partial when ANY term's own candidate read saturated (§22.1,
//     search-chunk-v1.md §21) -- had no test where terms disagreed; every
//     prior case used one term. Mutating `.some` to `.every` at
//     search.retrieve.ts's `partial` line left every existing test green.

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

describe("#30 coverage (search-chunk-v1.md §21) reaches oracle_search/oracle_ask, not just the 50-hit window", () => {
  // A kernel answer of only 2 hits (far under SEARCH_WINDOW=50) that still
  // reports its OWN candidate read saturated: the exact R22 residual measured
  // for real in search-chunk-retrieval-candidate-ceiling.test.ts. Before the
  // fix, `search.retrieve.ts` never looked at these three fields at all.
  const kernelHit = (id: string) => ({ node_id: id, revision_id: `${id}-rev`, title: id, snippet: id, chunk_ids: [], match: "ngram" });
  const partialKeyword = { match: "ngram", scan_reason: null, coverage: "partial", coverage_reason: "candidate_ceiling", candidate_ceiling: 4096, hits: [kernelHit("A"), kernelHit("B")] };

  test("retrieve() carries the kernel's coverage/coverage_reason/candidate_ceiling through, independent of the 50-hit window (fts)", async () => {
    const { retrieve } = await import("../src/mcp/legacy-v3/search.retrieve");
    const kb = async (method: string) => {
      if (method === "searchKnowledgeKeyword") return partialKeyword;
      throw new Error(`unexpected ${method}`);
    };
    const retrieved = await retrieve(kb, "probe", "fts");
    // The 50-hit window was NOT hit (only 2 merged hits) -- that signal must
    // stay honest on its own -- but the kernel's own coverage must still show.
    expect(retrieved.saturated).toBe(false);
    expect(retrieved).toMatchObject({ coverage: "partial", coverageReason: "candidate_ceiling", candidateCeiling: 4096 });
  });

  test("retrieve() carries the kernel's coverage through for vector mode too", async () => {
    const { retrieve } = await import("../src/mcp/legacy-v3/search.retrieve");
    const kb = async (method: string) => {
      if (method === "searchKnowledgeSemantic") return { ...partialKeyword, hits: [kernelHit("A")] };
      throw new Error(`unexpected ${method}`);
    };
    const retrieved = await retrieve(kb, "probe", "vector");
    expect(retrieved.saturated).toBe(false);
    expect(retrieved).toMatchObject({ coverage: "partial", coverageReason: "candidate_ceiling", candidateCeiling: 4096 });
  });

  test("a two-term fts query is partial when only ONE term's own read saturated (OR, not AND)", async () => {
    // "alpha beta" becomes two terms (search.keywordTerms.ts). "alpha"'s own
    // candidate read did not saturate; "beta"'s did. The v3 OR merge (v3's
    // own semantics: an entry matches when ANY word does) means the answer
    // still shows both hits, but `coverage` must say "partial" because SOME
    // underlying read may have missed matches -- not "full" (a wrong AND)
    // and not keyed to whichever term happened to run first or last.
    const { retrieve } = await import("../src/mcp/legacy-v3/search.retrieve");
    const fullTerm = { match: "ngram", scan_reason: null, coverage: "full" as const, coverage_reason: null, candidate_ceiling: 4096, hits: [kernelHit("A")] };
    const partialTerm = { ...partialKeyword, hits: [kernelHit("B")] };
    const calls: string[] = [];
    const kb = async (method: string, payload: Record<string, unknown>) => {
      calls.push(payload.query as string);
      if (method !== "searchKnowledgeKeyword") throw new Error(`unexpected ${method}`);
      return payload.query === "alpha" ? fullTerm : partialTerm;
    };
    const retrieved = await retrieve(kb, "alpha beta", "fts");
    expect(calls).toEqual(["alpha", "beta"]);
    expect(retrieved).toMatchObject({ coverage: "partial", coverageReason: "candidate_ceiling", candidateCeiling: 4096 });
    // Which term is the partial one must not matter: this time the FIRST
    // term's own read saturates and the second one's does not.
    const swapped = await retrieve(async (method: string, payload: Record<string, unknown>) => (payload.query === "alpha" ? partialTerm : fullTerm), "alpha beta", "fts");
    expect(swapped.coverage).toBe("partial");
  });

  test("oracle_search's compat_warnings say so even when its own 50-hit window looks complete", async () => {
    const { oracle_search } = await import("../src/mcp/legacy-v3/tools/oracle_search");
    const head = (id: string) => ({ revision: { title: id, body: `${id} body`, term_snapshot_json: "[]" }, lifecycle: null });
    const kb = async (method: string, payload: Record<string, unknown>) => {
      if (method === "searchKnowledgeKeyword") return partialKeyword;
      if (method === "getAcceptedHead") return head(payload.node_id as string);
      throw new Error(`unexpected ${method}`);
    };
    const context = { tool: "oracle_search", bank: "bank-a", kb, assertedPeer: null, authority: { operator: false, peers: null }, indexProfile: {} } as never;
    const result = (await oracle_search({ query: "probe" }, context)) as { total: number; compat_warnings: { code: string; field: string; detail: string }[] };
    expect(result.total).toBeLessThan(50);
    const coverageWarning = result.compat_warnings.find((w) => w.field === "metadata.coverage");
    expect(coverageWarning).toBeDefined();
    expect(coverageWarning?.code).toBe("partial");
    expect(coverageWarning?.detail).toContain("4096");
  });

  test("oracle_ask's compat_warnings say so too", async () => {
    const { oracle_ask } = await import("../src/mcp/legacy-v3/tools/oracle_ask");
    const head = (id: string) => ({ revision: { title: id, body: `${id} body`, term_snapshot_json: "[]" }, lifecycle: null });
    const kb = async (method: string, payload: Record<string, unknown>) => {
      if (method === "searchKnowledgeKeyword") return partialKeyword;
      if (method === "getAcceptedHead") return head(payload.node_id as string);
      throw new Error(`unexpected ${method}`);
    };
    const context = { tool: "oracle_ask", bank: "bank-a", kb, assertedPeer: null, authority: { operator: false, peers: null }, indexProfile: {} } as never;
    const result = (await oracle_ask({ question: "probe" }, context)) as { compat_warnings: { code: string; field: string; detail: string }[] };
    const coverageWarning = result.compat_warnings.find((w) => w.field === "search.coverage");
    expect(coverageWarning).toBeDefined();
    expect(coverageWarning?.code).toBe("partial");
    expect(coverageWarning?.detail).toContain("4096");
  });

  // Chain-coverage slice (issue #31, docs/overnight/DECISIONS.md R21/R22,
  // search-chunk-v1.md §22/§24). §22 shipped the fields for oracle_search and
  // oracle_ask and said plainly oracle_search_chain was "unchanged... outside
  // the cited finding's scope" -- but its own reads carry the same three
  // fields (oracle_search_chain.ts:75 read `searchKnowledgeSemantic`'s answer
  // as only `{hits}` and dropped them on every hop). Written red first: before
  // the fix, `hits` is cast as `{ hits: KernelHit[] }` only, so `coverage`
  // never reached the tool -- only the two positive-warning tests below this
  // block's negative pin (the ones that expect a `hops.coverage` entry to
  // actually appear) failed (2 fail). The negative "full" pin immediately
  // below passed either way: `.some(...)` over a `hops.coverage` field that
  // never arrives is trivially false.
  test("a 'full' kernel answer at every hop produces NO coverage warning (pins the always-partial mutant for the chain path, per finding item 2)", async () => {
    expect((await runChain(["full", "full", "full"])).compat_warnings.some((w) => w.field === "hops.coverage")).toBe(false);
  });

  test("one hop's own candidate read saturating is disclosed even when a later hop's does not (aggregated OR across hops, the same shape retrieve() uses across fts terms)", async () => {
    const result = await runChain(["partial", "full"]);
    const warning = result.compat_warnings.find((w) => w.field === "hops.coverage");
    expect(warning).toBeDefined();
    expect(warning?.code).toBe("partial");
    expect(warning?.detail).toContain("4096");
    expect(warning?.detail).toContain("candidate_ceiling");
  });

  test("hop order does not matter: the LATER hop saturating is disclosed too", async () => {
    const result = await runChain(["full", "partial"]);
    expect(result.compat_warnings.some((w) => w.field === "hops.coverage")).toBe(true);
  });

  test("oracle_search's compat_warnings say nothing when the kernel's own read is full (negative pin, finding item 2)", async () => {
    const { oracle_search } = await import("../src/mcp/legacy-v3/tools/oracle_search");
    const fullKeyword = { match: "ngram", scan_reason: null, coverage: "full" as const, coverage_reason: null, candidate_ceiling: 4096, hits: [kernelHit("A")] };
    const head = (id: string) => ({ revision: { title: id, body: `${id} body`, term_snapshot_json: "[]" }, lifecycle: null });
    const kb = async (method: string, payload: Record<string, unknown>) => {
      if (method === "searchKnowledgeKeyword") return fullKeyword;
      if (method === "getAcceptedHead") return head(payload.node_id as string);
      throw new Error(`unexpected ${method}`);
    };
    const context = { tool: "oracle_search", bank: "bank-a", kb, assertedPeer: null, authority: { operator: false, peers: null }, indexProfile: {} } as never;
    const result = (await oracle_search({ query: "probe" }, context)) as { compat_warnings: { code: string; field: string; detail: string }[] };
    expect(result.compat_warnings.some((w) => w.field === "metadata.coverage")).toBe(false);
  });

  test("oracle_ask's compat_warnings say nothing when the kernel's own read is full (negative pin, finding item 2)", async () => {
    const { oracle_ask } = await import("../src/mcp/legacy-v3/tools/oracle_ask");
    const fullKeyword = { match: "ngram", scan_reason: null, coverage: "full" as const, coverage_reason: null, candidate_ceiling: 4096, hits: [kernelHit("A")] };
    const head = (id: string) => ({ revision: { title: id, body: `${id} body`, term_snapshot_json: "[]" }, lifecycle: null });
    const kb = async (method: string, payload: Record<string, unknown>) => {
      if (method === "searchKnowledgeKeyword") return fullKeyword;
      if (method === "getAcceptedHead") return head(payload.node_id as string);
      throw new Error(`unexpected ${method}`);
    };
    const context = { tool: "oracle_ask", bank: "bank-a", kb, assertedPeer: null, authority: { operator: false, peers: null }, indexProfile: {} } as never;
    const result = (await oracle_ask({ question: "probe" }, context)) as { compat_warnings: { code: string; field: string; detail: string }[] };
    expect(result.compat_warnings.some((w) => w.field === "search.coverage")).toBe(false);
  });

  test("retrieve() reports 'full' (fts) when nothing saturated -- pins the literal mutant the finding names (`const partial = true`)", async () => {
    const { retrieve } = await import("../src/mcp/legacy-v3/search.retrieve");
    const fullKeyword = { match: "ngram", scan_reason: null, coverage: "full" as const, coverage_reason: null, candidate_ceiling: 4096, hits: [kernelHit("A")] };
    const kb = async (method: string) => {
      if (method === "searchKnowledgeKeyword") return fullKeyword;
      throw new Error(`unexpected ${method}`);
    };
    const retrieved = await retrieve(kb, "probe", "fts");
    expect(retrieved).toMatchObject({ coverage: "full", coverageReason: null });
  });
});

// Chain-coverage slice (issue #31): oracle_search_chain.ts:75 read
// `searchKnowledgeSemantic`'s answer as only `{ hits }` and dropped `coverage`/
// `coverage_reason`/`candidate_ceiling` on every hop. Fixed by carrying them
// AGGREGATED across hops (OR: partial the moment any hop's own candidate read
// saturated), the same shape `retrieve()` already uses to OR together several
// fts terms (search-chunk-v1.md §22.1) -- chosen over a per-hop field because
// `Hop` is a small, already-pinned public record (`mcp-v3-search.test.ts`
// asserts its exact shape with `toMatchObject`), and `compat_warnings` is
// already the adapter's one channel for "something the kernel measured
// changed the answer's completeness" (the same reasoning search-chunk-v1.md
// §22.1 gives for putting oracle_search's own signal there instead of a new
// top-level key).
function kernelHit(id: string, distance = 0.1) {
  return { node_id: id, revision_id: `${id}-rev`, title: id, snippet: id, chunk_ids: [], distance };
}
async function runChain(hopsCoverage: ("full" | "partial")[], args: Record<string, unknown> = {}) {
  const { oracle_search_chain } = await import("../src/mcp/legacy-v3/tools/oracle_search_chain");
  const head = (id: string) => ({ node: { id }, revision: { id: `${id}-rev`, title: id, body: `${id} body`, term_snapshot_json: "[]" }, lifecycle: null });
  let hop = 0;
  const kb = async (method: string, payload: Record<string, unknown>) => {
    if (method === "searchKnowledgeSemantic") {
      const coverage = hopsCoverage[hop] ?? "full";
      hop += 1;
      return { hits: [kernelHit(`n${hop}`)], coverage, coverage_reason: coverage === "partial" ? "candidate_ceiling" : null, candidate_ceiling: 4096 };
    }
    if (method === "getAcceptedHead") return head(payload.node_id as string);
    if (method === "createTrace") return { outcome: "created" };
    throw new Error(`unexpected ${method}`);
  };
  const context = { tool: "oracle_search_chain", bank: "bank-a", kb, assertedPeer: null, authority: { operator: false, peers: null }, indexProfile: {} } as never;
  return (await oracle_search_chain({ query: "seed", maxHops: hopsCoverage.length, breadth: 1, ...args }, context)) as {
    compat_warnings: { code: string; field: string; detail: string }[];
  };
}
