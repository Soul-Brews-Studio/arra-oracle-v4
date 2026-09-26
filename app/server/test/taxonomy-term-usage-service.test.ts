// K6+K7 (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18 (K6+K7+V8)):
// `listTerms`, `listTermUsage` and `knowledgeStats` as content:read methods.
//
// Structural, isolation and grammar proofs run against a REAL fixture
// dataset through the gateless reader (`createFixture` seeds vocabularies
// and terms but no nodes, so it also doubles as the "empty workspace"
// baseline for K7). Counting semantics that need row shapes a real fixture
// cannot cheaply produce -- 1000+ node windows, a head whose projection was
// never reconciled, stored corruption, workspaces with differing data in
// every table -- live in `taxonomy-term-usage-scans.test.ts` (split out of
// this file in the second fix round, when it passed the 500-line cap). The
// real, populated end-to-end path (publish, count) is proved in
// `test/mcp-v3-stats.test.ts` through the v3 adapter's `oracle_concepts` /
// `oracle_stats`, which are K6/K7's first real callers.
//
// Written BEFORE the three methods existed. The red run (see
// `app/docs/contracts/taxonomy-write-v1.md`'s R18 amendment): with the kernel
// files held out, this file failed to load at all (`Cannot find module
// '../src/publication/service.knowledgeStats'`), and `mcp-v3-stats.test.ts`
// answered `not_yet_available`/`isError` for every step instead of the shape
// it asserts.

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
import { openEvidenceReader } from "../src/publication/service";
import { createFixture, type Fixture } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
/** Granted to the reader below, but never seeded: no `workspaces` row exists. */
const GAMMA = "gamma-workspace";
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
      principals: [{ id: "reader", disabled: false, workspaces: [{ name: ALPHA, actions: ["content:read"] }, { name: GAMMA, actions: ["content:read"] }], global_actions: [] }],
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
}, testTimeout(60_000));

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

  // Exact, from the seed manifest itself: 3 vocabularies (type,
  // memory_horizon, topic) and 5 terms (note, decision, short_term, storage,
  // retired_topic) per workspace. Two workspaces seeded this way ALSO sit in
  // the same dataset, so an unscoped count would read 6/10 here, not 3/5.
  // (The first cut compared alpha's count to beta's, which an unscoped count
  // passes too; the differing-data proof is in `taxonomy-term-usage-scans.test.ts`.)
  const seededCounts = (workspace: string) => {
    const seeded = fixture.workspaces[workspace]!;
    const terms = Object.values(seeded.term_ids).reduce((n, byName) => n + Object.keys(byName).length, 0);
    return { vocabularies: String(Object.keys(seeded.vocabulary_ids).length), terms: String(terms) };
  };

  test("knowledgeStats counts the seeded taxonomy and zero nodes, exactly, never null when exact", async () => {
    const stats = await taxonomy().knowledgeStats(bytes({ workspace_name: ALPHA }));
    expect(stats.nodes_total).toBe("0");
    expect(stats.nodes_eligible).toBe("0");
    expect(stats.by_type).toEqual([]);
    expect(stats.chunks).toEqual([]);
    expect(stats.last_updated_at).toBeNull();
    expect({ vocabularies: stats.vocabularies, terms: stats.terms }).toEqual(seededCounts(ALPHA));
    expect(seededCounts(ALPHA)).toEqual({ vocabularies: "3", terms: "5" });
  });

  test("isolation: beta counts only its own seed, not alpha's too", async () => {
    const beta = await taxonomy().knowledgeStats(bytes({ workspace_name: BETA }));
    expect(beta.nodes_total).toBe("0");
    expect({ vocabularies: beta.vocabularies, terms: beta.terms }).toEqual(seededCounts(BETA));
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

// Fix round (verifier finding 5, nonblocking): `listTerms`/`listTermUsage`
// were never called over HTTP or `kb_*` anywhere in this slice's tests (only
// `tools/list`), so the actual wire behaviour -- correct in every case the
// verifier checked by hand -- had no regression coverage. These pin exactly
// what was checked: `limit:201`/`type_term:""`/an extra key are `400`, a
// Thai `type_term` is `200` with an honest empty result, a body naming
// another workspace than the route is `400`, and a route to an ungranted
// bank is `403`.
describe("K6 wire: listTerms/listTermUsage grammar and reachability", () => {
  let access: ReturnType<typeof createKnowledgeAccess>;
  let app: ReturnType<typeof createApp>;
  const headers = { host: "127.0.0.1:3939", "content-type": "application/json", authorization: `Bearer ${READ_TOKEN}` };

  beforeAll(() => {
    access = createKnowledgeAccess({ datasetRoot: fixture.datasetRoot });
    configureKnowledgeAccess(access);
    const deps = { logCall: async () => {} } as unknown as StoreDependencies;
    const service = createOperationService({ policyPath }, deps);
    app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });
  });

  const http = (method: string, body: Record<string, unknown>) =>
    app.handle(new Request(`${ORIGIN}/api/knowledge/${ALPHA}/${method}`, { method: "POST", headers, body: JSON.stringify(body) }));

  test("listTerms is reachable over HTTP with real rows, matching the gateless reader", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const res = await http("listTerms", { workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, after_id: null, limit: 10, include_inactive: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { id: string }[] };
    expect(body.rows.map((r) => r.id).sort()).toEqual([seeded.term_ids.type.note.id, seeded.term_ids.type.decision.id].sort());
  });

  test("listTermUsage is reachable over MCP kb_listTermUsage, empty and full coverage on a node-free workspace", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const mcp = await app.handle(
      new Request(`${ORIGIN}/mcp/${ALPHA}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "kb_listTermUsage", arguments: { payload: { workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, type_term: null, limit: 10 } } },
        }),
      }),
    );
    const mcpBody = (await mcp.json()) as any;
    expect(mcpBody.result.isError).toBeUndefined();
    expect(JSON.parse(mcpBody.result.content[0].text)).toEqual({ rows: [], total_unique: "0", coverage: "full" });
  });

  test("limit:201 is invalid_value at /limit", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const res = await http("listTermUsage", { workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, type_term: null, limit: 201 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; path: string };
    expect(body).toMatchObject({ code: "invalid_value", path: "/limit" });
  });

  test("type_term:'' is invalid_value at /type_term (empty is not the same as null)", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const res = await http("listTermUsage", { workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, type_term: "", limit: 10 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; path: string };
    expect(body).toMatchObject({ code: "invalid_value", path: "/type_term" });
  });

  test("a Thai type_term is a well-formed request: 200 with an honest empty result on a node-free workspace", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const res = await http("listTermUsage", { workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, type_term: "หลงลืม", limit: 10 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [], total_unique: "0", coverage: "full" });
  });

  test("an unexpected extra key is unexpected_field", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const res = await http("listTermUsage", { workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, type_term: null, limit: 10, extra: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("unexpected_field");
  });

  test("a body naming another workspace than the route is refused, generically, before admission", async () => {
    const seeded = fixture.workspaces[BETA]!;
    const res = await http("listTermUsage", { workspace_name: BETA, vocabulary_id: seeded.vocabulary_ids.type, type_term: null, limit: 10 });
    expect(res.status).toBe(400);
  });

  test("a granted bank with no workspaces row is invalid_reference at /workspace_name, never exact-looking zeros (second fix round)", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const bodies: Record<string, Record<string, unknown>> = {
      knowledgeStats: { workspace_name: GAMMA },
      listTermUsage: { workspace_name: GAMMA, vocabulary_id: seeded.vocabulary_ids.type, type_term: null, limit: 10 },
      listTerms: { workspace_name: GAMMA, vocabulary_id: seeded.vocabulary_ids.type, after_id: null, limit: 10, include_inactive: false },
    };
    for (const [method, body] of Object.entries(bodies)) {
      const res = await app.handle(
        new Request(`${ORIGIN}/api/knowledge/${GAMMA}/${method}`, { method: "POST", headers, body: JSON.stringify(body) }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_reference", path: "/workspace_name" });
    }
  });

  test("a route to a bank this credential is not granted on is 403", async () => {
    const seeded = fixture.workspaces[BETA]!;
    const res = await app.handle(
      new Request(`${ORIGIN}/api/knowledge/${BETA}/listTermUsage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workspace_name: BETA, vocabulary_id: seeded.vocabulary_ids.type, type_term: null, limit: 10 }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
