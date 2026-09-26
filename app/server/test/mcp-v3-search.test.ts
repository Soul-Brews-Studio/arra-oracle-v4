// Slice V5 -- v3 recall over the #30 knowledge searches: oracle_search,
// oracle_ask, oracle_search_chain (docs/overnight/V3-PARITY.md §4.4, §7 "V5";
// DECISIONS.md R18 D3, R7 "never fused", R14 inside-word Thai). Written
// BEFORE the three tools existed, and while the catalogue still named the
// nonexistent `searchChunksKeyword`/`searchChunksSemantic`.
//
// Real gate, real dataset, real wire: `fixtures/v3-compat-v1/core/search-child.ts`
// boots the production app inside `exec_with_gate` with a deterministic stub
// query embedder (never Ollama) and replays MCP calls. Keyword scores are
// consumed as ORDER only: the kernel's raw score is being re-defined
// concurrently (R21), so nothing here pins a raw kernel score value.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGated } from "./helpers/publication-fixture";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";
import { loadShape, matchesShape } from "./helpers/v3-compat-shapes";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "search-child.ts");
const A = "ws-v5-a";
const B = "ws-v5-b";
const APFS = "APFS snapshots keep a rollback point: take one with tmutil localsnapshot before disk surgery.";

const learn = (label: string, pattern: string, extra: Record<string, unknown> = {}) => ({
  label, bank: A, tool: "oracle_learn", args: { pattern, ...extra },
  capture: [{ name: label, path: ["id"] }, { name: `${label}_rev`, path: ["v4", "revision_id"] }],
});
const search = (label: string, args: Record<string, unknown>, as = "rw", bank = A) => ({ label, as, bank, tool: "oracle_search", args });
const lifecycle = (label: string, tool: string, request: Record<string, unknown>) => ({ label, bank: A, tool, args: { payload: { workspace_name: A, peer_name: null, ...request } } });
const embed = (node: string) => ({ label: `embed_${node}`, bank: A, embed: { node: { $ref: node } } });

let taxonomy: TaxonomyFixture;
let work: string;
let out: Record<string, any> = {};
let captured: Record<string, any> = {};
let setupError: string | null = null;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arra-v3-search-"));
  await mkdir(join(work, "legacy"));
  taxonomy = await createTaxonomyFixture([A, B]);
  const steps = [
    learn("apfs", APFS, { concepts: ["apfs", "backup"], project: "github.com/laris-co/homelab" }),
    learn("thai", "หลงลืม: การลืมคือค่า is_active เป็น binary ไม่ใช่การค่อย ๆ จางหาย", { concepts: ["thai"] }),
    learn("lost", "หลงทาง: getting lost is a different word"),
    learn("q", "APFS on project Q only", { project: "github.com/other/q" }),
    learn("univ", "APFS universal note with no project"),
    learn("extra", "APFS extra note so that v3's default limit of 5 truncates"),
    { label: "handoff", bank: A, tool: "oracle_handoff", args: { content: "# Handoff: APFS migration\n\nmoved the APFS volume", slug: "apfs-migration" }, capture: [{ name: "handoff", path: ["id"] }] },
    learn("old", "APFS superseded tip: use diskutil snapshot"),
    learn("new", "APFS replacement tip: prefer tmutil"),
    lifecycle("supersede", "kb_supersedeNode", {
      node_id: { $ref: "old" }, expected_revision_id: { $ref: "old_rev" }, new_node_id: { $ref: "new" }, new_revision_id: { $ref: "new_rev" },
      reason: "replaced", operation_id: "v5-test-supersede-1",
    }),
    learn("ret", "APFS retired tip: never do this"),
    lifecycle("retire", "kb_retireNode", { node_id: { $ref: "ret" }, expected_revision_id: { $ref: "ret_rev" }, reason: "wrong", operation_id: "v5-test-retire-1" }),
    { label: "learn_b", as: "other", bank: B, tool: "oracle_learn", args: { pattern: "APFS in bank b only: zzbankbmarker is never visible from bank a" }, capture: [{ name: "b", path: ["id"] }] },
    { label: "old_head", bank: A, tool: "kb_getAcceptedHead", args: { payload: { workspace_name: A, node_id: { $ref: "old" } } } },
    search("s_apfs", { query: "APFS", limit: 10 }),
    search("s_first", { query: "tmutil localsnapshot before disk surgery", limit: 5 }),
    search("s_thai", { query: "ลืม", mode: "hybrid", limit: 8 }),
    search("s_short", { query: "ลื" }),
    search("s_fts", { query: "APFS", mode: "fts", limit: 10 }),
    search("s_project", { query: "APFS", project: "github.com/laris-co/homelab", limit: 10 }),
    search("s_type_learning", { query: "APFS", type: "learning", limit: 10 }),
    search("s_type_retro", { query: "APFS", type: "retro" }),
    search("s_offset", { query: "APFS", limit: 1, offset: 1 }),
    search("s_default_limit", { query: "APFS" }),
    search("s_model", { query: "APFS", model: "bge-m3" }),
    search("s_asof", { query: "APFS", asOf: "2026-01-01T00:00:00Z" }),
    search("s_blank", { query: "   " }),
    search("s_badmode", { query: "APFS", mode: "fused" }),
    search("s_vector_before", { query: "APFS snapshots rollback", mode: "vector", limit: 5 }),
    ...["apfs", "thai", "q", "univ", "handoff", "new", "old"].map(embed),
    search("s_vector", { query: APFS, mode: "vector", limit: 3 }),
    { ...search("s_vector_down", { query: "APFS", mode: "vector", limit: 10 }), embedderDown: true },
    search("s_other", { query: "APFS", limit: 10 }, "other", B),
    search("s_ro", { query: "APFS", limit: 10 }, "ro"),
    search("s_cross", { query: "zzbankbmarker", limit: 10 }),
    // The same keyword query again, AFTER the embed steps: writing a chunk's
    // vector rewrites its row, which may move BM25 ties. Order is only
    // compared between calls made against the same dataset state.
    search("s_apfs_after", { query: "APFS", limit: 10 }),
    { label: "ask_false", bank: A, tool: "oracle_ask", args: { question: "tmutil localsnapshot", llm: false } },
    { label: "ask_default", bank: A, tool: "oracle_ask", args: { q: "tmutil localsnapshot" } },
    { label: "ask_none", bank: A, tool: "oracle_ask", args: { question: "zzqqxx qqzzyy", llm: false } },
    { label: "ask_ro", as: "ro", bank: A, tool: "oracle_ask", args: { question: "APFS", llm: false, limit: 2 } },
    { label: "alias", bank: A, tool: "arra_search", args: { query: "APFS", limit: 10 } },
    { label: "chain", bank: A, peer: "neo", tool: "oracle_search_chain", args: { query: "APFS snapshots keep a rollback point", maxHops: 3, breadth: 1 },
      capture: [{ name: "chain0", path: ["traceIds", 0] }, { name: "chain1", path: ["traceIds", 1] }] },
    { label: "chain_t0", bank: A, tool: "kb_getTrace", args: { payload: { workspace_name: A, id: { $ref: "chain0" } } } },
    { label: "chain_t1", bank: A, tool: "kb_getTrace", args: { payload: { workspace_name: A, id: { $ref: "chain1" } } } },
    { label: "chain_hits0", bank: A, tool: "kb_listTraceHits", args: { payload: { workspace_name: A, trace_id: { $ref: "chain0" }, after_position: null, limit: 50 } } },
    { label: "chain_ro", as: "ro", bank: A, tool: "oracle_search_chain", args: { query: "APFS" } },
    { label: "chain_down", bank: A, tool: "oracle_search_chain", args: { query: "APFS" }, embedderDown: true },
  ];
  try {
    const result = await runGated(taxonomy.datasetRoot, CHILD, [taxonomy.datasetRoot, work, JSON.stringify({ banks: { a: A, b: B }, steps })], {
      deadlineMs: 240_000,
      env: { ARRA_DATA_DIR: join(work, "legacy"), ARRA_KNOWLEDGE_DATASET_ROOT: taxonomy.datasetRoot },
    });
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (result.code !== 0 || line === undefined) throw new Error(`search-child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
    ({ outcomes: out, captured } = JSON.parse(line));
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  }
}, 300_000);

afterAll(async () => {
  await taxonomy?.cleanup();
  if (work) await rm(work, { recursive: true, force: true });
});

const ok = (label: string) => {
  const res = out[label];
  expect(res?.status, `${label}: ${JSON.stringify(res)?.slice(0, 600)}`).toBe(200);
  expect(res.isError, `${label}: ${JSON.stringify(res.value)?.slice(0, 600)}`).toBe(false);
  return res.value;
};
const refused = (label: string) => {
  const res = out[label];
  expect(res?.status).toBe(200);
  expect(res.isError, `${label}: ${JSON.stringify(res.value)?.slice(0, 600)}`).toBe(true);
  return res.value;
};
const ids = (label: string) => (ok(label).results as { id: string }[]).map((r) => r.id);
const warned = (value: any, code: string, field: string) =>
  (value.compat_warnings ?? []).some((w: any) => w.code === code && w.field === field);
const shape = loadShape("oracle_search");

test("setup: the gated V5 session ran", () => {
  expect(setupError).toBeNull();
  for (const label of ["apfs", "thai", "lost", "q", "univ", "extra", "handoff", "old", "new", "ret", "learn_b"]) {
    expect(out[label]?.isError, `${label}: ${JSON.stringify(out[label])?.slice(0, 800)}`).toBe(false);
  }
  expect(out.supersede.value).toMatchObject({ outcome: "accepted" });
  expect(out.retire.value).toMatchObject({ outcome: "accepted" });
});

describe("the three tools are advertised by grant (catalogue names the real #30 methods)", () => {
  const names = (who: string) => (out.lists?.[who] ?? []).map((t: { name: string }) => t.name);
  test("rw sees oracle_search, oracle_ask and oracle_search_chain; ro sees only the two reads; other sees search in its bank", () => {
    for (const name of ["oracle_search", "oracle_ask", "oracle_search_chain"]) expect(names("rw")).toContain(name);
    expect(names("ro")).toContain("oracle_search");
    expect(names("ro")).toContain("oracle_ask");
    expect(names("ro")).not.toContain("oracle_search_chain");
    expect(names("other")).toContain("oracle_search");
  });
  test("each description states the D3 recall change", () => {
    const listed = out.lists.rw.filter((t: { name: string }) => ["oracle_search", "oracle_ask", "oracle_search_chain"].includes(t.name));
    expect(listed).toHaveLength(3);
    for (const tool of listed) expect(tool.description).toContain("Superseded and retired entries are excluded");
  });
});

describe("oracle_search: keyword (fts, and hybrid answered honestly as keyword)", () => {
  test("results have v3's shape, one per node, with source fts and a rank-derived score", () => {
    const value = ok("s_apfs");
    expect(matchesShape(value, shape.topLevel as Record<string, unknown>, shape)).toEqual([]);
    expect(value.query).toBe("APFS");
    expect(value.total).toBe(value.results.length);
    for (const r of value.results) expect(r.source).toBe("fts");
    const scores = value.results.map((r: { score: number }) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(scores).size).toBe(scores.length);
    expect(value.metadata.score_kind).toBe("reciprocal_rank");
    expect(warned(value, "semantic_change", "score")).toBe(true);
    expect(warned(value, "field_unavailable", "source_file")).toBe(true);
  });
  test("the best match comes first; a learning keeps its type and concepts", () => {
    const first = ok("s_first").results[0];
    expect(first.id).toBe(captured.apfs);
    expect(first.type).toBe("learning");
    expect(first.concepts.sort()).toEqual(["apfs", "backup"]);
    expect(first.content).toBe(APFS);
  });
  test("hybrid (the v3 default) is answered by keyword, says so, and never fuses (R7)", () => {
    const value = ok("s_apfs");
    expect(value.metadata.mode).toBe("hybrid");
    expect(value.metadata.mode_effective).toBe("fts");
    expect(warned(value, "semantic_change", "mode")).toBe(true);
    const fts = ok("s_fts");
    expect(fts.metadata.mode_effective).toBe("fts");
    expect(warned(fts, "semantic_change", "mode")).toBe(false);
    expect("vectorAvailable" in fts.metadata).toBe(false);
    expect(fts.results.map((r: { id: string }) => r.id)).toEqual(ids("s_apfs"));
  });
  test("R14: ลืม finds the learning holding หลงลืม (inside-word), and not หลงทาง", () => {
    const value = ok("s_thai");
    expect(value.results[0].id).toBe(captured.thai);
    expect(ids("s_thai")).not.toContain(captured.lost);
    expect(value.metadata.match).toBe("ngram");
  });
  test("a 2-code-point query is a substring scan, and says so", () => {
    const value = ok("s_short");
    expect(value.metadata.match).toBe("substring_scan");
    expect(ids("s_short")).toContain(captured.thai);
  });
});

describe("oracle_search: D3 recall, filters, paging and refusals", () => {
  test("superseded and retired nodes are absent from recall, yet the superseded one stays readable by id", () => {
    for (const label of ["s_apfs", "s_fts", "s_ro", "s_vector_down"]) {
      expect(ids(label)).not.toContain(captured.old);
      expect(ids(label)).not.toContain(captured.ret);
    }
    expect(ids("s_apfs")).toContain(captured.new);
    expect(ok("old_head").node.id).toBe(captured.old);
  });
  test("project P returns P and _universal, not Q", () => {
    const got = ids("s_project");
    expect(got).toContain(captured.apfs);
    expect(got).toContain(captured.univ);
    expect(got).not.toContain(captured.q);
  });
  test("type learning drops the handoff note; a v3 type nobody wrote matches nothing", () => {
    expect(ids("s_apfs")).toContain(captured.handoff);
    expect(ids("s_type_learning")).not.toContain(captured.handoff);
    expect(ids("s_type_learning")).toContain(captured.apfs);
    expect(ok("s_type_retro").results).toEqual([]);
  });
  test("offset pages over the same order; v3's default limit is 5; metadata.total counts every match", () => {
    expect(ids("s_offset")).toEqual([ids("s_apfs")[1]]);
    expect(ok("s_offset").metadata.total).toBe(ok("s_apfs").metadata.total);
    expect(ok("s_default_limit").results).toHaveLength(5);
    expect(ok("s_default_limit").metadata.limit).toBe(5);
  });
  test("model is ignored and named; asOf, a blank query and an unknown mode are refused", () => {
    expect(warned(ok("s_model"), "argument_ignored", "model")).toBe(true);
    for (const [label, path] of [["s_asof", "/asOf"], ["s_blank", "/query"], ["s_badmode", "/mode"]]) {
      expect(refused(label!).compat).toMatchObject({ code: "unsupported_argument", tool: "oracle_search", path });
    }
  });
});

describe("oracle_search: semantic (mode vector)", () => {
  test("before the backfill it is a warning with no results, not an error", () => {
    const value = ok("s_vector_before");
    expect(value.results).toEqual([]);
    expect(value.metadata.mode_effective).toBe("vector");
    expect(value.metadata.vectorAvailable).toBe(true);
    expect(typeof value.metadata.warning).toBe("string");
  });
  test("after the backfill the nearest node comes first, source vector, superseded never", () => {
    const value = ok("s_vector");
    expect(matchesShape(value, shape.topLevel as Record<string, unknown>, shape)).toEqual([]);
    expect(value.results[0].id).toBe(captured.apfs);
    for (const r of value.results) expect(r.source).toBe("vector");
    expect(ids("s_vector")).not.toContain(captured.old);
    expect(value.metadata.sources).toEqual({ fts: 0, vector: value.results.length, hybrid: 0 });
  });
  test("with the embedder down it falls back to keyword, as v3 did, and says so", () => {
    const value = ok("s_vector_down");
    expect(value.metadata.mode).toBe("vector");
    expect(value.metadata.mode_effective).toBe("fts");
    expect(value.metadata.vectorAvailable).toBe(false);
    expect(value.metadata.warning).toContain("Vector search unavailable");
    expect(ids("s_vector_down")).toEqual(ids("s_apfs_after"));
  });
});

describe("oracle_search: isolation and grants", () => {
  test("another bank's principal sees only its own node; bank-a never sees bank-b", () => {
    expect(ids("s_other")).toEqual([captured.b]);
    expect(ids("s_cross")).toEqual([]);
    expect(ids("s_apfs")).not.toContain(captured.b);
  });
  test("a read-only principal searches; arra_search is oracle_search", () => {
    expect(ids("s_ro")).toEqual(ids("s_apfs_after"));
    expect(ok("alias").results).toEqual(ok("s_apfs_after").results);
    expect(ok("alias").results.length).toBeGreaterThan(0);
  });
});

describe("oracle_ask (llm:false extractive; llm:true is not_yet_available and says so)", () => {
  test("llm:false answers extractively over keyword hits, with citations", () => {
    const value = ok("ask_false");
    expect(value.mode).toBe("extractive");
    expect(value.noEvidence).toBe(false);
    expect(value.answer.startsWith("[1] ")).toBe(true);
    expect(value.citations[0].id).toBe(captured.apfs);
    expect(value.citationIndexes[0]).toBe(1);
    expect(value.sources[0]).toMatchObject({ index: 1, id: captured.apfs, stale: false });
    expect(warned(value, "semantic_change", "llm")).toBe(false);
  });
  test("the v3 default (llm true, question as q) is extractive with a not_yet_available warning", () => {
    const value = ok("ask_default");
    expect(value.query).toBe("tmutil localsnapshot");
    expect(value.mode).toBe("extractive");
    expect(value.compat_warnings.find((w: any) => w.field === "llm")?.detail).toContain("not_yet_available");
  });
  test("no match is noEvidence, never an invented answer; a read-only principal may ask", () => {
    const none = ok("ask_none");
    expect(none).toMatchObject({ noEvidence: true, citations: [], answer: "No evidence found in indexed oracle documents." });
    expect(ok("ask_ro").sources.length).toBeLessThanOrEqual(2);
    for (const s of ok("ask_ro").sources) expect([captured.old, captured.ret]).not.toContain(s.id);
  });
});

describe("oracle_search_chain (content:write; one immutable trace per hop)", () => {
  test("hops follow semantic neighbours and each writes a trace linked to the previous by prev_id", () => {
    const value = ok("chain");
    expect(value.traceIds.length).toBeGreaterThanOrEqual(2);
    expect(value.hops.map((h: { traceId: string }) => h.traceId)).toEqual(value.traceIds);
    expect(value.hops[0].bestId).toBe(captured.apfs);
    expect(new Set(value.results.map((r: { id: string }) => r.id)).size).toBe(value.results.length);
    for (const r of value.results) expect([captured.old, captured.ret]).not.toContain(r.id);
    const t0 = ok("chain_t0");
    const t1 = ok("chain_t1");
    expect(t0).toMatchObject({ id: captured.chain0, mode: "chain", status: "complete", prev_id: null, depth: "0", peer_name: "neo" });
    expect(t1).toMatchObject({ id: captured.chain1, mode: "chain", prev_id: captured.chain0, depth: "0" });
    const rows = ok("chain_hits0").rows;
    expect(rows[0]).toMatchObject({ kind: "node_revision", ref: "hop 0 rank 1" });
    expect(JSON.parse(rows[0].target)).toMatchObject({ node_id: captured.apfs });
  });
  test("a read-only principal gets 403, like an unknown tool; a down embedder is a refusal that says why", () => {
    expect(out.chain_ro.status).toBe(403);
    expect(out.chain_ro.body).toEqual({ error: "forbidden" });
    const down = refused("chain_down");
    expect(down.compat).toMatchObject({ code: "kernel_error", tool: "oracle_search_chain" });
    expect(down.error).toContain("Vector search unavailable");
  });
});
