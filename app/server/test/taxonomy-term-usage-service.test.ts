// K6+K7 (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18 (K6+K7+V8)):
// `listTerms`, `listTermUsage` and `knowledgeStats` as content:read methods.
//
// Structural, isolation and grammar proofs run against a REAL fixture
// dataset through the gateless reader (`createFixture` seeds vocabularies
// and terms but no nodes, so it also doubles as the "empty workspace"
// baseline for K7). The bounded-scan `coverage`/null-on-truncation paths are
// proved with a hand-built fake `DatasetAdapter` -- fast, deterministic, and
// the only practical way to exercise a 1000+-row window without writing
// 1000+ real rows through the gate. The real, populated end-to-end path
// (publish, reconcile, count) is proved separately in
// `test/mcp-v3-stats.test.ts` through the v3 adapter's `oracle_concepts` /
// `oracle_stats`, which are K6/K7's first real callers.
//
// Written BEFORE the three methods existed (see PR description / structured
// result for the red run: `KNOWLEDGE_METHODS.listTerms` etc. were
// `undefined` and every `taxonomy.<method>` call threw "not a function").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createOperationService, type StoreDependencies } from "../src/auth/service";
import { KNOWLEDGE_METHODS } from "../src/knowledge/registry";
import { PEER_FIELDS } from "../src/knowledge/registry.peerFields";
import { createKnowledgeAccess } from "../src/knowledge/transport";
import { configureKnowledgeAccess, createMcpAdapter } from "../src/mcp";
import { knowledgeStats } from "../src/publication/service.knowledgeStats";
import { listTermUsage } from "../src/publication/service.listTermUsage";
import { listTerms } from "../src/publication/service.listTerms";
import { openEvidenceReader } from "../src/publication/service";
import { type DatasetAdapter } from "../src/publication/service.types";
import { createFixture, type Fixture } from "./helpers/publication-fixture";

const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const ORIGIN = "http://127.0.0.1:3939";
const READ_TOKEN = "8".repeat(64);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

let fixture: Fixture;
let dir: string;
let policyPath: string;
let reader: Awaited<ReturnType<typeof openEvidenceReader>>;
type TermsReader = {
  listTerms(b: Uint8Array): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null }>;
  listTermUsage(b: Uint8Array): Promise<{ rows: unknown[]; total_unique: string; coverage: string }>;
  knowledgeStats(b: Uint8Array): Promise<Record<string, unknown>>;
};
const taxonomy = () => reader.taxonomy as unknown as TermsReader;

beforeAll(async () => {
  fixture = await createFixture([ALPHA, BETA]);
  reader = await openEvidenceReader(fixture.datasetRoot);
  dir = await mkdtemp(join(tmpdir(), "arra-k6k7-"));
  policyPath = join(dir, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [{ id: "reader", disabled: false, workspaces: [{ name: ALPHA, actions: ["content:read"] }], global_actions: [] }],
      credentials: [
        {
          id: "cred-reader",
          principal_id: "reader",
          sha256: createHash("sha256").update(READ_TOKEN, "ascii").digest("hex"),
          not_before: "2020-01-01T00:00:00.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
          revoked: false,
        },
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
}, 60_000);

afterAll(async () => {
  configureKnowledgeAccess(null);
  await fixture?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("registry + peer-field classification", () => {
  test("all three are content:read, scoped at the request root", () => {
    for (const method of ["listTerms", "listTermUsage", "knowledgeStats"]) {
      expect(KNOWLEDGE_METHODS[method]?.action).toBe("content:read");
      expect(KNOWLEDGE_METHODS[method]?.scopePath).toEqual([]);
    }
  });

  test("all three assert no acting peer (R3/R7 exhaustiveness)", () => {
    expect(PEER_FIELDS.listTerms).toEqual([]);
    expect(PEER_FIELDS.listTermUsage).toEqual([]);
    expect(PEER_FIELDS.knowledgeStats).toEqual([]);
  });
});

describe("K6 kernel: listTerms", () => {
  test("lists a vocabulary's active terms, keyset-paginated by id", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const first = await taxonomy().listTerms(
      bytes({ workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, after_id: null, limit: 1, include_inactive: false }),
    );
    expect(first.rows.length).toBe(1);
    expect(first.next_after_id).toBe(first.rows[0]!.id as string);

    const second = await taxonomy().listTerms(
      bytes({ workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, after_id: first.next_after_id, limit: 10, include_inactive: false }),
    );
    const ids = [first.rows[0]!.id, ...second.rows.map((r) => r.id)].sort();
    expect(ids).toEqual([seeded.term_ids.type.note.id, seeded.term_ids.type.decision.id].sort());
    expect(second.next_after_id).toBeNull();
  });

  test("include_inactive: false hides a retired term; true shows it", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const active = await taxonomy().listTerms(
      bytes({ workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.topic, after_id: null, limit: 10, include_inactive: false }),
    );
    expect(active.rows.map((r) => r.id)).toEqual([seeded.term_ids.topic.storage.id]);

    const all = await taxonomy().listTerms(
      bytes({ workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.topic, after_id: null, limit: 10, include_inactive: true }),
    );
    expect(all.rows.map((r) => r.id).sort()).toEqual([seeded.term_ids.topic.storage.id, seeded.term_ids.topic.retired_topic.id].sort());
    const retired = all.rows.find((r) => r.id === seeded.term_ids.topic.retired_topic.id);
    expect(retired?.is_active).toBe(false);
  });

  test("isolation: another workspace's vocabulary id returns no rows here", async () => {
    const beta = fixture.workspaces[BETA]!;
    const fromAlpha = await taxonomy().listTerms(
      bytes({ workspace_name: ALPHA, vocabulary_id: beta.vocabulary_ids.type, after_id: null, limit: 10, include_inactive: true }),
    );
    expect(fromAlpha.rows).toEqual([]);
  });

  test("closed keys and grammar are governed arra-error/v1 envelopes", async () => {
    const code = async (run: Promise<unknown>) => {
      try {
        await run;
      } catch (error) {
        return (error as { toJSON?: () => unknown }).toJSON?.();
      }
      return "no error";
    };
    const seeded = fixture.workspaces[ALPHA]!;
    expect(await code(taxonomy().listTerms(bytes({ workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, after_id: null, limit: 0, include_inactive: false })))).toMatchObject({
      code: "invalid_value",
    });
    expect(
      await code(taxonomy().listTerms(bytes({ workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, after_id: null, limit: 10 }))),
    ).toMatchObject({ code: "missing_field" });
  });
});

describe("K6/K7 baseline: an empty-of-nodes workspace measures exactly zero", () => {
  test("listTermUsage over a vocabulary with no published content is empty and full coverage", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const usage = await taxonomy().listTermUsage(
      bytes({ workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, type_term: null, limit: 10 }),
    );
    expect(usage).toEqual({ rows: [], total_unique: "0", coverage: "full" });
  });

  test("knowledgeStats counts the seeded taxonomy and zero nodes, never null when exact", async () => {
    const stats = await taxonomy().knowledgeStats(bytes({ workspace_name: ALPHA }));
    expect(stats.nodes_total).toBe("0");
    expect(stats.nodes_eligible).toBe("0");
    expect(stats.by_type).toEqual([]);
    expect(stats.chunks).toEqual([]);
    expect(stats.last_updated_at).toBeNull();
    expect(Number(stats.vocabularies)).toBeGreaterThanOrEqual(3);
    expect(Number(stats.terms)).toBeGreaterThanOrEqual(5);
  });

  test("isolation: beta's workspace is measured independently of alpha", async () => {
    const alpha = await taxonomy().knowledgeStats(bytes({ workspace_name: ALPHA }));
    const beta = await taxonomy().knowledgeStats(bytes({ workspace_name: BETA }));
    expect(beta.nodes_total).toBe("0");
    expect(beta.vocabularies).toBe(alpha.vocabularies); // same seed shape, independently counted
  });
});

describe("K6/K7 bounded scans: coverage/null, not a fabricated partial count", () => {
  /** A minimal fake satisfying just the four methods these two kernels call. */
  function fakeAdapter(tables: Record<string, Record<string, unknown>[]>): DatasetAdapter {
    const notImplemented = (): Promise<never> => Promise.reject(new Error("not implemented in this fake"));
    const adapter: DatasetAdapter = {
      async query(table: string, _predicate: string, limit?: number) {
        const rows = tables[table] ?? [];
        return limit === undefined ? rows : rows.slice(0, limit);
      },
      async orderedProjection(table: string, _predicate: string, columns: string[], ordering: { column: string; ascending: boolean }, limit: number) {
        const rows = [...(tables[table] ?? [])];
        rows.sort((a, b) => {
          const av = a[ordering.column] as string;
          const bv = b[ordering.column] as string;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return ordering.ascending ? cmp : -cmp;
        });
        return rows.slice(0, limit).map((row) => Object.fromEntries(columns.map((c) => [c, row[c]])));
      },
      async count(table: string, _predicate: string) {
        return (tables[table] ?? []).length;
      },
      async refresh() {},
      version: notImplemented,
      deleteDerivedScope: notImplemented,
      append: notImplemented,
      updateWhere: notImplemented,
      updateSearchChunkEmbedding: notImplemented,
      release() {},
    };
    return adapter;
  }

  /** `count` distinct nodes, each with its OWN head revision carrying one
   *  "apfs" term row -- a shared revision across nodes cannot happen in a
   *  real dataset (`current_revision_id` is per-node), so the fixture must
   *  not shortcut that to stay a faithful proof. */
  function manyTaggedNodes(count: number): { nodes: Record<string, unknown>[]; node_revision_terms: Record<string, unknown>[] } {
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: `node${String(i).padStart(17, "0")}`,
      workspace_name: "ws",
      current_revision_id: `rev${String(i).padStart(18, "0")}`,
    }));
    const node_revision_terms = nodes.map((n) => ({
      workspace_name: "ws",
      revision_id: n.current_revision_id,
      vocabulary_id: "vocabAAAAAAAAAAAAAAAA",
      term_id: "termA",
      term_name_snapshot: "apfs",
    }));
    return { nodes, node_revision_terms };
  }

  test("listTermUsage discloses coverage:partial once the node scan window is exceeded", async () => {
    // 1001 distinct nodes (one past the 1000-row window), each tagged apfs.
    const adapter = fakeAdapter(manyTaggedNodes(1001));
    const result = await listTermUsage(
      adapter,
      bytes({ workspace_name: "ws", vocabulary_id: "vocabAAAAAAAAAAAAAAAA", type_term: null, limit: 10 }),
    );
    expect(result.coverage).toBe("partial");
    // The 1000-row window still counted whatever it saw -- a partial count
    // that says so, never a silently wrong "full".
    expect(result.rows[0]?.count).toBe("1000");
  });

  test("listTermUsage is full coverage at exactly the window size", async () => {
    const adapter = fakeAdapter(manyTaggedNodes(1000));
    const result = await listTermUsage(
      adapter,
      bytes({ workspace_name: "ws", vocabulary_id: "vocabAAAAAAAAAAAAAAAA", type_term: null, limit: 10 }),
    );
    expect(result.coverage).toBe("full");
    expect(result.rows[0]?.count).toBe("1000");
  });

  test("knowledgeStats: by_type and last_updated_at are null (never a guessed partial) once the node window is exceeded", async () => {
    const nodes = Array.from({ length: 1001 }, (_, i) => ({
      id: `node${String(i).padStart(17, "0")}`,
      workspace_name: "ws",
      current_revision_id: "revAAAAAAAAAAAAAAAAAA",
      updated_at: BigInt(1_700_000_000_000_000 + i * 1000),
    }));
    const adapter = fakeAdapter({ nodes, node_revisions: [], supersede_log: [], search_chunks_v1: [], vocabularies: [], terms: [] });
    const stats = await knowledgeStats(adapter, bytes({ workspace_name: "ws" }));
    expect(stats.nodes_total).toBe("1001");
    expect(stats.by_type).toBeNull();
    expect(stats.last_updated_at).toBeNull();
  });

  test("knowledgeStats: nodes_eligible is null once the supersede_log scan is exceeded, while nodes_total stays exact", async () => {
    const nodes = [{ id: "nodeAAAAAAAAAAAAAAAAA", workspace_name: "ws", current_revision_id: "revAAAAAAAAAAAAAAAAAA", updated_at: 1_700_000_000_000_000n }];
    const supersedeLog = Array.from({ length: 2001 }, (_, i) => ({ workspace_name: "ws", old_id: `old${i}` }));
    const adapter = fakeAdapter({
      nodes,
      node_revisions: [{ id: "revAAAAAAAAAAAAAAAAAA", workspace_name: "ws", term_snapshot_json: JSON.stringify([{ vocabulary_name_snapshot: "type", term_name_snapshot: "learning" }]) }],
      supersede_log: supersedeLog,
      search_chunks_v1: [],
      vocabularies: [],
      terms: [],
    });
    const stats = await knowledgeStats(adapter, bytes({ workspace_name: "ws" }));
    expect(stats.nodes_total).toBe("1");
    expect(stats.nodes_eligible).toBeNull();
    expect(stats.by_type).toEqual([{ term: "learning", count: "1" }]);
  });
});

describe("K6/K7 transport: content:read on HTTP and MCP", () => {
  test("a content:read-only credential reaches all three over HTTP and MCP, with the same answer", async () => {
    const access = createKnowledgeAccess({ datasetRoot: fixture.datasetRoot });
    configureKnowledgeAccess(access);
    const deps = { logCall: async () => {} } as unknown as StoreDependencies;
    const service = createOperationService({ policyPath }, deps);
    const app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });
    const headers = { host: "127.0.0.1:3939", "content-type": "application/json", authorization: `Bearer ${READ_TOKEN}` };
    const listed = await app.handle(
      new Request(`${ORIGIN}/mcp/${ALPHA}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }),
    );
    const names = ((await listed.json()) as any).result.tools.map((t: { name: string }) => t.name);
    for (const method of ["listTerms", "listTermUsage", "knowledgeStats"]) expect(names).toContain(`kb_${method}`);

    const http = await app.handle(
      new Request(`${ORIGIN}/api/knowledge/${ALPHA}/knowledgeStats`, { method: "POST", headers, body: JSON.stringify({ workspace_name: ALPHA }) }),
    );
    expect(http.status).toBe(200);
    const httpBody = await http.json();
    const mcp = await app.handle(
      new Request(`${ORIGIN}/mcp/${ALPHA}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kb_knowledgeStats", arguments: { payload: { workspace_name: ALPHA } } } }),
      }),
    );
    const mcpBody = (await mcp.json()) as any;
    expect(mcpBody.result.isError).toBeUndefined();
    expect(JSON.parse(mcpBody.result.content[0].text)).toEqual(httpBody);
  });
});
