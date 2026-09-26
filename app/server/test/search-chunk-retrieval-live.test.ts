// #30 retrieval (overnight R7 #30 part + R14): live HTTP + MCP round trip on a
// REAL target-19 dataset written inside the REAL writer gate.
//
//   publishRevision -> indexRevisionChunks -> writeChunkEmbedding (stub
//   vectors) -> searchKnowledgeKeyword / searchKnowledgeSemantic
//
// over BOTH transports, through the same registry entries, admission and
// `createKnowledgeAccess` composition production uses (see
// `fixtures/transport-v1/search/child.ts`). The query embedder is the one
// injected seam: a deterministic stub keyed by query text.
//
// Isolation on the wire: a credential granted only on beta is refused on
// alpha; beta's copy of the same Thai text never answers an alpha search, and
// alpha's never answers a beta one.
//
// Chunk seams on the wire: a node whose ทะเลสาบ is cut by the 1000-code-unit
// chunk boundary (chunk 0 ends "ทะ", chunk 1 starts "เลสาบ") is found for
// ทะเลสาบ through the index, and for ทะเล -- split 2+2, no whole trigram in
// either chunk -- through the seam scan, on both transports.

import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated } from "./helpers/publication-fixture";

const CHILD = join(import.meta.dir, "fixtures", "transport-v1", "search", "child.ts");
const TIMEOUT_MS = 150_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const PROFILE = "all-minilm";
const THAI = "ฉันหลงลืมกุญแจไว้ที่บ้าน";

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/transport-v1/search/child.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const basis = (i: number) => Array.from({ length: 384 }, (_, j) => (j === i ? 1 : 0));
const NODE_THAI = pad("liveThai");
const NODE_FOX = pad("liveFox");
const NODE_BETA = pad("liveBeta");
const NODE_STRADDLE = pad("liveStraddle");

type Step = {
  label: string;
  transport: "http" | "mcp" | "tools_list";
  token: "write" | "read" | "other";
  bank: "alpha" | "beta";
  method?: string;
  body?: unknown;
  capture?: { name: string; path: (string | number)[] };
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

runIt(
  "publish -> index -> embed -> keyword and semantic search, over HTTP and MCP, workspace-isolated",
  async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-search-live-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));
    const alpha = fixture.workspaces[ALPHA]!;
    const beta = fixture.workspaces[BETA]!;

    const s = (label: string, transport: Step["transport"], token: Step["token"], method: string | undefined, body?: unknown, extra: Partial<Step> = {}): Step => ({
      label,
      transport,
      token,
      bank: "alpha",
      method,
      body,
      ...extra,
    });
    const publish = (label: string, bank: "alpha" | "beta", node: string, title: string, body: string) =>
      s(label, "http", bank === "alpha" ? "write" : "other", "publishRevision", {
        operation_id: `op-${label}`,
        content: revisionEnvelope(bank === "alpha" ? ALPHA : BETA, bank === "alpha" ? alpha : beta, node, { title, body }),
      }, { bank, capture: { name: `REV_${label}`, path: ["revision_id"] } });
    const index = (label: string, bank: "alpha" | "beta", node: string, rev: string, transport: "http" | "mcp") =>
      s(label, transport, bank === "alpha" ? "write" : "other", "indexRevisionChunks", {
        workspace_name: bank === "alpha" ? ALPHA : BETA,
        node_id: node,
        revision_id: `@REV_${rev}`,
        chunker_version: "chunker/v1",
        embedding_profile: { name: PROFILE, dims: 384 },
      }, { bank, capture: { name: `CHUNK_${label}`, path: transport === "http" ? ["rows", 0, "id"] : ["rows", 0, "id"] } });
    const embed = (label: string, bank: "alpha" | "beta", chunk: string, vector: number[], transport: "http" | "mcp") =>
      s(label, transport, bank === "alpha" ? "write" : "other", "writeChunkEmbedding", {
        workspace_name: bank === "alpha" ? ALPHA : BETA,
        id: `@CHUNK_${chunk}`,
        embedding: vector,
      }, { bank });
    const keyword = (query: string, workspace = ALPHA, limit?: number) => ({ workspace_name: workspace, query, ...(limit ? { limit } : {}) });
    const semantic = (query: string, workspace = ALPHA) => ({ workspace_name: workspace, query });

    const steps: Step[] = [
      publish("thai", "alpha", NODE_THAI, "บันทึก", THAI),
      publish("fox", "alpha", NODE_FOX, "fox note", "the quick brown fox"),
      publish("beta", "beta", NODE_BETA, "beta note", THAI),
      publish("straddle", "alpha", NODE_STRADDLE, "t", `${"a".repeat(995)}ทะเลสาบ tail`),
      index("idx_thai", "alpha", NODE_THAI, "thai", "http"),
      index("idx_fox", "alpha", NODE_FOX, "fox", "mcp"),
      index("idx_beta", "beta", NODE_BETA, "beta", "http"),
      index("idx_straddle", "alpha", NODE_STRADDLE, "straddle", "http"),
      embed("emb_thai", "alpha", "idx_thai", basis(0), "http"),
      embed("emb_fox", "alpha", "idx_fox", basis(1), "mcp"),
      embed("emb_beta", "beta", "idx_beta", basis(0), "http"),

      s("tools_read", "tools_list", "read", undefined),
      s("kw_http", "http", "read", "searchKnowledgeKeyword", keyword("ลืม")),
      s("kw_mcp", "mcp", "read", "searchKnowledgeKeyword", keyword("ลืม")),
      s("kw_short_http", "http", "read", "searchKnowledgeKeyword", keyword("ลื")),
      s("kw_short_mcp", "mcp", "read", "searchKnowledgeKeyword", keyword("ลื")),
      s("kw_false_positive_http", "http", "read", "searchKnowledgeKeyword", keyword("หลงทาง")),
      s("kw_straddle_http", "http", "read", "searchKnowledgeKeyword", keyword("ทะเลสาบ")),
      s("kw_straddle_mcp", "mcp", "read", "searchKnowledgeKeyword", keyword("ทะเลสาบ")),
      s("kw_seam_http", "http", "read", "searchKnowledgeKeyword", keyword("ทะเล")),
      s("kw_seam_mcp", "mcp", "read", "searchKnowledgeKeyword", keyword("ทะเล")),
      s("sem_http", "http", "read", "searchKnowledgeSemantic", semantic("q-e0")),
      s("sem_mcp", "mcp", "read", "searchKnowledgeSemantic", semantic("q-e0")),
      s("sem_embedder_down_http", "http", "read", "searchKnowledgeSemantic", semantic("q-missing")),
      s("sem_embedder_down_mcp", "mcp", "read", "searchKnowledgeSemantic", semantic("q-missing")),

      // Isolation and admission on the real gate.
      s("kw_beta_http", "http", "other", "searchKnowledgeKeyword", keyword("ลืม", BETA), { bank: "beta" }),
      s("sem_beta_mcp", "mcp", "other", "searchKnowledgeSemantic", semantic("q-e0", BETA), { bank: "beta" }),
      s("kw_other_on_alpha_http", "http", "other", "searchKnowledgeKeyword", keyword("ลืม")),
      s("kw_other_on_alpha_mcp", "mcp", "other", "searchKnowledgeKeyword", keyword("ลืม")),
      s("sem_other_on_alpha_http", "http", "other", "searchKnowledgeSemantic", semantic("q-e0")),
      s("kw_body_mismatch_http", "http", "read", "searchKnowledgeKeyword", keyword("ลืม", BETA)),
      s("kw_body_mismatch_mcp", "mcp", "read", "searchKnowledgeKeyword", keyword("ลืม", BETA)),
      s("kw_bad_limit_http", "http", "read", "searchKnowledgeKeyword", keyword("ลืม", ALPHA, 999)),
    ];

    const result = await runGated(
      fixture.datasetRoot,
      CHILD,
      [fixture.datasetRoot, workDir, JSON.stringify({ banks: { alpha: ALPHA, beta: BETA }, embedderProfile: PROFILE, queryVectors: { "q-e0": basis(0) }, steps })],
      { deadlineMs: TIMEOUT_MS - 10_000 },
    );
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
    const out: Record<string, any> = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);

    // ── setup landed on the wire ──────────────────────────────────────────
    for (const label of ["thai", "fox", "beta", "straddle", "idx_thai", "idx_beta", "idx_straddle", "emb_thai", "emb_beta"]) {
      expect(out[label]?.status, `${label}: ${JSON.stringify(out[label])}`).toBe(200);
    }
    for (const label of ["idx_fox", "emb_fox"]) expect(out[label]?.ok, `${label}: ${JSON.stringify(out[label])}`).toBe(true);
    const revThai = out.thai.body.revision_id as string;
    const chunkThai = out.idx_thai.body.rows[0].id as string;

    // ── advertised to a content:read credential ──────────────────────────
    expect(out.tools_read.tools).toEqual(expect.arrayContaining(["kb_searchKnowledgeKeyword", "kb_searchKnowledgeSemantic"]));

    // ── keyword: same answer over both transports ─────────────────────────
    expect(out.kw_http.status, JSON.stringify(out.kw_http)).toBe(200);
    expect(out.kw_http.body.match).toBe("ngram");
    expect(out.kw_http.body.hits).toHaveLength(1);
    expect(out.kw_http.body.hits[0]).toMatchObject({
      node_id: NODE_THAI,
      revision_id: revThai,
      title: "บันทึก",
      chunk_ids: [chunkThai],
      match: "ngram",
    });
    expect(out.kw_http.body.hits[0].snippet).toContain("หลงลืม");
    expect(out.kw_mcp.ok, JSON.stringify(out.kw_mcp)).toBe(true);
    expect(out.kw_mcp.value).toEqual(out.kw_http.body);

    expect(out.kw_short_http.status).toBe(200);
    expect(out.kw_short_http.body).toMatchObject({ match: "substring_scan", scan_reason: "short_query" });
    expect(out.kw_short_http.body.hits.map((h: { node_id: string }) => h.node_id)).toEqual([NODE_THAI]);
    expect(out.kw_short_mcp.value).toEqual(out.kw_short_http.body);
    expect(out.kw_false_positive_http.body).toMatchObject({ match: "ngram", hits: [] });

    // ── an occurrence cut by a chunk boundary, on both transports ─────────
    expect(out.idx_straddle.body.rows).toHaveLength(2);
    expect(out.kw_straddle_http.body.match).toBe("ngram");
    expect(out.kw_straddle_http.body.hits.map((h: { node_id: string }) => h.node_id)).toEqual([NODE_STRADDLE]);
    expect(out.kw_straddle_http.body.hits[0].snippet).toContain("ทะเลสาบ");
    expect(out.kw_straddle_mcp.value).toEqual(out.kw_straddle_http.body);
    expect(out.kw_seam_http.body.match).toBe("ngram");
    expect(out.kw_seam_http.body.hits).toHaveLength(1);
    expect(out.kw_seam_http.body.hits[0]).toMatchObject({ node_id: NODE_STRADDLE, match: "substring_scan", rank: 1 });
    expect(out.kw_seam_mcp.value).toEqual(out.kw_seam_http.body);

    // ── semantic: nearest first, same answer over both transports ─────────
    expect(out.sem_http.status, JSON.stringify(out.sem_http)).toBe(200);
    expect(out.sem_http.body).toMatchObject({ embedding_profile: PROFILE, metric: "l2_squared" });
    expect(out.sem_http.body.hits.map((h: { node_id: string }) => h.node_id)).toEqual([NODE_THAI, NODE_FOX]);
    expect(out.sem_http.body.hits[0].distance).toBeCloseTo(0, 5);
    expect(out.sem_http.body.hits[1].distance).toBeCloseTo(2, 5);
    expect(out.sem_mcp.ok, JSON.stringify(out.sem_mcp)).toBe(true);
    expect(out.sem_mcp.value).toEqual(out.sem_http.body);
    // No model answer: a documented 503 envelope, never a hang or a 500.
    // R21: model_unavailable, the same closed code chat uses (#32 / R9).
    expect(out.sem_embedder_down_http.status).toBe(503);
    expect(out.sem_embedder_down_http.body).toMatchObject({ code: "model_unavailable" });
    expect(out.sem_embedder_down_mcp.isError).toBe(true);
    // The MCP envelope carries the same closed code, not just an error flag
    // (`auth/service.ts`'s `runMcp` puts the PublicationError's `.toJSON()` in
    // `message`).
    expect(JSON.parse(out.sem_embedder_down_mcp.message)).toMatchObject({ code: "model_unavailable" });

    // ── isolation ─────────────────────────────────────────────────────────
    expect(out.kw_beta_http.status).toBe(200);
    expect(out.kw_beta_http.body.hits.map((h: { node_id: string }) => h.node_id)).toEqual([NODE_BETA]);
    expect(out.sem_beta_mcp.ok, JSON.stringify(out.sem_beta_mcp)).toBe(true);
    expect(out.sem_beta_mcp.value.hits.map((h: { node_id: string }) => h.node_id)).toEqual([NODE_BETA]);
    expect(JSON.stringify(out.kw_http.body)).not.toContain(NODE_BETA);
    expect(JSON.stringify(out.sem_http.body)).not.toContain(NODE_BETA);
    expect(out.kw_other_on_alpha_http.status).toBe(403);
    expect(out.kw_other_on_alpha_mcp).toEqual({ denied: "forbidden" });
    expect(out.sem_other_on_alpha_http.status).toBe(403);
    expect(out.kw_body_mismatch_http.status).toBe(400);
    expect(out.kw_body_mismatch_mcp.isError).toBe(true);
    expect(out.kw_bad_limit_http.status).toBe(400);
    expect(out.kw_bad_limit_http.body).toMatchObject({ code: "invalid_value", path: "/limit" });
    // A refused credential and a refused body never reached the embedder.
    expect(out.embedCalls.filter((q: string) => q === "q-e0")).toHaveLength(3);
  },
  TIMEOUT_MS,
);
