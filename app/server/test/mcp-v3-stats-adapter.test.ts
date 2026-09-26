// V8 fix round -- an independent verifier's finding 3 on the first cut of
// this slice (docs/overnight/V3-PARITY.md §2.5, §4.3; DECISIONS.md R18
// (K6+K7+V8)): `oracle_stats` (`mcp/legacy-v3/tools/oracle_stats.ts`) put
// MADE-UP values on the wire whenever `knowledgeStats` (K7) reported a field
// as unmeasured (`null`) -- `by_type` became `{}`, `fts_indexed` became `0`,
// and `fts_status` became the flatly false `"empty"`, none of it named in
// `compat_warnings` for `fts_status`/`last_indexed`. That directly
// contradicts §2.5 ("a field v4 cannot fill is present as null and named in
// compat_warnings") and this slice's own "measured not guessed" claim.
//
// Unit-level on purpose: `oracle_stats`/`oracle_concepts` are pure functions
// of `context.kb`, so a stub `kb` reproduces the verifier's exact repro
// (`{nodes_total:'1500', by_type:null, chunks:null, last_updated_at:null}`)
// without a dataset, a gate, or a server. `test/mcp-v3-stats.test.ts` covers
// the real, populated, end-to-end path; this file covers the adapter's
// translation of an UNMEASURED kernel answer, which that real path cannot
// reach without writing past the K7 scan windows (1000+ nodes / 5000+ chunks).
//
// Written BEFORE the fix, seen red: `by_type` was `{}` not `null`,
// `fts_indexed` was `0` not `null`, `fts_status` was `"empty"` not `null`,
// and `compat_warnings` had no `fts_status`/`last_indexed` entries.

import { describe, expect, test } from "bun:test";
import type { V3ToolContext } from "../src/mcp/legacy-v3/handlers";
import { oracle_concepts } from "../src/mcp/legacy-v3/tools/oracle_concepts";
import { oracle_stats } from "../src/mcp/legacy-v3/tools/oracle_stats";

type Warning = { code: string; field: string; detail: string };

function contextWithKb(kb: (method: string, payload: Record<string, unknown>) => Promise<unknown>): V3ToolContext {
  return {
    tool: "oracle_stats",
    bank: "ws-adapter-test",
    kb,
    assertedPeer: null,
    authority: {} as V3ToolContext["authority"],
    indexProfile: {} as V3ToolContext["indexProfile"],
  };
}

const NO_CONCEPTS_VOCAB = async (method: string) => {
  if (method === "lookupVocabularyByName") return null;
  throw new Error(`unexpected kb call: ${method}`);
};

describe("oracle_stats: an unmeasured field is null and named, never a fabricated value", () => {
  test("by_type unmeasured: by_type is null (not {}), and last_indexed is warned too (same truncated scan)", async () => {
    const context = contextWithKb(async (method) => {
      if (method === "knowledgeStats") {
        return {
          nodes_total: "1500",
          nodes_eligible: "1500",
          by_type: null,
          chunks: [],
          vocabularies: "3",
          terms: "5",
          last_updated_at: null,
        };
      }
      return NO_CONCEPTS_VOCAB(method);
    });
    const result = (await oracle_stats({}, context)) as Record<string, unknown>;

    expect(result.by_type).toBeNull();
    expect(result.last_indexed).toBeNull();
    const warnings = result.compat_warnings as Warning[];
    expect(warnings).toContainEqual(expect.objectContaining({ code: "partial", field: "by_type" }));
    expect(warnings).toContainEqual(expect.objectContaining({ code: "partial", field: "last_indexed" }));
  });

  test("chunks unmeasured: fts_indexed and fts_status are null (never 0 / a guessed \"empty\"), vector_status is unknown", async () => {
    const context = contextWithKb(async (method) => {
      if (method === "knowledgeStats") {
        return {
          nodes_total: "1500",
          nodes_eligible: "1500",
          by_type: [],
          chunks: null,
          vocabularies: "3",
          terms: "5",
          last_updated_at: "2026-09-27T00:00:00.000Z",
        };
      }
      return NO_CONCEPTS_VOCAB(method);
    });
    const result = (await oracle_stats({}, context)) as Record<string, unknown>;

    expect(result.fts_indexed).toBeNull();
    expect(result.fts_status).toBeNull();
    expect(result.vector_status).toBe("unknown");
    const warnings = result.compat_warnings as Warning[];
    expect(warnings).toContainEqual(expect.objectContaining({ code: "partial", field: "fts_indexed" }));
    expect(warnings).toContainEqual(expect.objectContaining({ code: "partial", field: "fts_status" }));
  });

  test("both unmeasured at once (the verifier's exact repro: a bank over 1000 nodes and 5000 chunk rows)", async () => {
    const context = contextWithKb(async (method) => {
      if (method === "knowledgeStats") {
        return {
          nodes_total: "1500",
          nodes_eligible: null,
          by_type: null,
          chunks: null,
          vocabularies: "3",
          terms: "5",
          last_updated_at: null,
        };
      }
      return NO_CONCEPTS_VOCAB(method);
    });
    const result = (await oracle_stats({}, context)) as Record<string, unknown>;

    expect(result.total_documents).toBe(1500);
    expect(result.by_type).toBeNull();
    expect(result.fts_indexed).toBeNull();
    expect(result.fts_status).toBeNull();
    expect(result.last_indexed).toBeNull();
    expect(result.vector_status).toBe("unknown");
    const fields = (result.compat_warnings as Warning[]).map((w) => w.field);
    expect(new Set(fields)).toEqual(new Set(["by_type", "fts_indexed", "fts_status", "last_indexed"]));
  });

  test("a genuinely empty, fully-measured workspace stays {} / 0 / \"empty\" with no warnings (not confused with unmeasured)", async () => {
    const context = contextWithKb(async (method) => {
      if (method === "knowledgeStats") {
        return {
          nodes_total: "0",
          nodes_eligible: "0",
          by_type: [],
          chunks: [],
          vocabularies: "3",
          terms: "5",
          last_updated_at: null,
        };
      }
      return NO_CONCEPTS_VOCAB(method);
    });
    const result = (await oracle_stats({}, context)) as Record<string, unknown>;

    expect(result.by_type).toEqual({});
    expect(result.fts_indexed).toBe(0);
    expect(result.fts_status).toBe("empty");
    expect(result.last_indexed).toBeNull();
    expect(result.compat_warnings).toBeUndefined();
  });
});

// Second fix round (verifier, nonblocking): M18/M19 -- dropping the `partial`
// warning from either tool when `listTermUsage` reports `coverage:"partial"`
// -- survived every test, and so did the `semantic_change` warning firing on
// v3's own `learning` type. Handoffs, which v3 never counted, were counted
// here with no warning at all.
describe("K6 honesty carried through oracle_concepts / oracle_stats", () => {
  const MEASURED_STATS = {
    nodes_total: "3",
    nodes_eligible: "3",
    by_type: [{ term: "learning", count: "2" }, { term: "note", count: "1" }],
    chunks: [],
    vocabularies: "4",
    terms: "9",
    last_updated_at: "2026-09-27T00:00:00.000Z",
  };
  type Usage = { rows: { term_id: string; name: string; count: string }[]; total_unique: string; coverage: "full" | "partial" };
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const kbWith = (usage: Usage) => async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === "knowledgeStats") return MEASURED_STATS;
    if (method === "lookupVocabularyByName") return { id: "vocabCONCEPTSAAAAAAAA" };
    if (method === "listTermUsage") return usage;
    throw new Error(`unexpected kb call: ${method}`);
  };
  const row = (name: string, count: string) => ({ term_id: `concept-${name}`, name, count });

  test("oracle_concepts: coverage partial is a `partial` warning on concepts (kills M19)", async () => {
    const result = (await oracle_concepts({}, contextWithKb(kbWith({ rows: [row("apfs", "1000")], total_unique: "1", coverage: "partial" })))) as Record<string, unknown>;
    expect(result.concepts).toEqual([{ name: "apfs", count: 1000 }]);
    expect(result.compat_warnings).toEqual([expect.objectContaining({ code: "partial", field: "concepts" })]);
  });

  test("oracle_concepts: coverage full carries no warning at all", async () => {
    const result = (await oracle_concepts({}, contextWithKb(kbWith({ rows: [row("apfs", "2")], total_unique: "1", coverage: "full" })))) as Record<string, unknown>;
    expect(result).toEqual({ concepts: [{ name: "apfs", count: 2 }], total_unique: 1, filter_type: "all" });
  });

  test("oracle_stats: coverage partial is a `partial` warning on unique_concepts (kills M18)", async () => {
    const result = (await oracle_stats({}, contextWithKb(kbWith({ rows: [row("apfs", "1000")], total_unique: "1", coverage: "partial" })))) as Record<string, unknown>;
    expect(result.unique_concepts).toBe(1);
    expect(result.compat_warnings).toEqual([expect.objectContaining({ code: "partial", field: "unique_concepts" })]);
  });

  test("oracle_concepts: v3's own type `learning` passes through with NO semantic_change warning", async () => {
    calls.length = 0;
    const result = (await oracle_concepts({ type: "learning" }, contextWithKb(kbWith({ rows: [row("apfs", "2")], total_unique: "1", coverage: "full" })))) as Record<string, unknown>;
    expect(result.compat_warnings).toBeUndefined();
    expect(calls.find((c) => c.method === "listTermUsage")?.payload.type_term).toBe("learning");
  });

  test("oracle_concepts: v3's principle/pattern/retro have no v4 type of that name -- semantic_change, never silent", async () => {
    for (const type of ["principle", "pattern", "retro"]) {
      const result = (await oracle_concepts({ type }, contextWithKb(kbWith({ rows: [], total_unique: "0", coverage: "full" })))) as Record<string, unknown>;
      expect(result.compat_warnings).toEqual([expect.objectContaining({ code: "semantic_change", field: "type" })]);
    }
  });

  test("oracle_concepts: a counted `handoff` concept is named -- v3 kept handoffs as inbox files and never counted them", async () => {
    const result = (await oracle_concepts({}, contextWithKb(kbWith({ rows: [row("apfs", "2"), row("handoff", "1")], total_unique: "2", coverage: "full" })))) as Record<string, unknown>;
    expect(result.compat_warnings).toEqual([expect.objectContaining({ code: "semantic_change", field: "concepts" })]);
  });

  test("oracle_stats: handoffs counted in total_documents are named, with their count", async () => {
    calls.length = 0;
    const result = (await oracle_stats({}, contextWithKb(kbWith({ rows: [row("apfs", "2"), row("handoff", "1")], total_unique: "2", coverage: "full" })))) as Record<string, unknown>;
    expect(result.total_documents).toBe(3);
    const warning = (result.compat_warnings as Warning[]).find((w) => w.code === "semantic_change");
    expect(warning).toMatchObject({ field: "total_documents" });
    expect(warning!.detail).toContain("1 ");
    // The whole ranking is asked for, not just 1 row, so a handoff row is seen.
    expect(calls.find((c) => c.method === "listTermUsage")?.payload.limit).toBe(200);
  });

  test("oracle_stats: no handoff concept, full coverage, measured stats: no warnings", async () => {
    const result = (await oracle_stats({}, contextWithKb(kbWith({ rows: [row("apfs", "2")], total_unique: "1", coverage: "full" })))) as Record<string, unknown>;
    expect(result.compat_warnings).toBeUndefined();
  });
});
