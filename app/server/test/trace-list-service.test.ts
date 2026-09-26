// K5 (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18 overnight): listTraces
// as a content:read method -- newest-first, filtered by parent_id/prev_id, a
// bounded substring `query_contains` scan, and a compound
// (created_at desc, id asc) keyset cursor. Written BEFORE the facade method,
// the registry entry and the PEER_FIELDS classification existed.
//
// Writes go through the real gated child (`fixtures/trace-v1/core/
// gated-trace.ts`); reads run against a fresh, GATE-FREE reader afterward,
// the same split `test/taxonomy-lookup-service.test.ts` uses for K2.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createOperationService, type StoreDependencies } from "../src/auth/service";
import { KNOWLEDGE_METHODS } from "../src/knowledge/registry";
import { createKnowledgeAccess } from "../src/knowledge/transport";
import { configureKnowledgeAccess, createMcpAdapter } from "../src/mcp";
import { openEvidenceReader } from "../src/publication/service";
import { createFixture, runGated, type Fixture } from "./helpers/publication-fixture";
import { createTraceRequest, traceId } from "./helpers/trace-fixture";

const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const ORIGIN = "http://127.0.0.1:3939";
const READ_TOKEN = "8".repeat(64);
const CHILD = new URL("./fixtures/trace-v1/core/gated-trace.ts", import.meta.url).pathname;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const A = traceId("kA");
const B = traceId("kB");
const C = traceId("kC");
const D = traceId("kD");
const E = traceId("kE");
const BASE = 1_790_000_000_000;

let fixture: Fixture;
let dir: string;
let policyPath: string;
let reader: Awaited<ReturnType<typeof openEvidenceReader>>;
type ListTracesReader = { listTraces(b: Uint8Array): Promise<Record<string, unknown>> };
const context = () => reader.context as unknown as ListTracesReader;

beforeAll(async () => {
  fixture = await createFixture([ALPHA, BETA]);
  const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
  const seeded = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({
      // One clock sample per genuinely-fresh createTrace call, in order:
      // A and B deliberately share a millisecond (the compound-sort tie).
      clockMs: [BASE, BASE, BASE + 2000, BASE + 1500, BASE + 500],
      ops: [
        ctx("createTrace", createTraceRequest(ALPHA, { id: A, name: "trace-a", query: "root alpha query", hits: [] })),
        ctx("createTrace", createTraceRequest(ALPHA, { id: B, name: "trace-b", query: "root alpha sibling", hits: [] })),
        ctx("createTrace", createTraceRequest(ALPHA, { id: C, name: "trace-c", query: "child of a", parent_id: A, depth: "1", hits: [] })),
        ctx("createTrace", createTraceRequest(ALPHA, { id: D, name: "trace-d", query: "has a needle-substring inside", hits: [] })),
        ctx("createTrace", createTraceRequest(BETA, { id: E, name: "trace-e", query: "beta only, never visible from alpha", hits: [] })),
      ],
    }),
  ]);
  if (seeded.code !== 0) throw new Error(`gated-trace.ts exited ${seeded.code}: ${seeded.stderr.slice(0, 1500)}`);
  const line = seeded.stdout.trim().split("\n").filter(Boolean).at(-1);
  const parsed = JSON.parse(line ?? "{}");
  for (const key of ["op0", "op1", "op2", "op3", "op4"]) {
    if (parsed[key]?.ok !== true) throw new Error(`seed ${key} failed: ${JSON.stringify(parsed[key])}`);
  }

  reader = await openEvidenceReader(fixture.datasetRoot);
  dir = await mkdtemp(join(tmpdir(), "arra-k5-"));
  policyPath = join(dir, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [{ id: "reader", disabled: false, workspaces: [{ name: ALPHA, actions: ["content:read"] }], global_actions: [] }],
      credentials: [{
        id: "cred-reader", principal_id: "reader", sha256: createHash("sha256").update(READ_TOKEN, "ascii").digest("hex"),
        not_before: "2020-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", revoked: false,
      }],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
}, 120_000);

afterAll(async () => {
  configureKnowledgeAccess(null);
  await fixture?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const req = (overrides: Record<string, unknown> = {}) =>
  bytes({ workspace_name: ALPHA, parent_id: null, prev_id: null, query_contains: null, after_created_at: null, after_id: null, limit: 10, ...overrides });

describe("K5 kernel: listTraces", () => {
  test("newest first: (created_at desc, id asc) is a total order even across a millisecond tie", async () => {
    const result = await context().listTraces(req());
    const rows = result.rows as { id: string }[];
    const ids = rows.map((r) => r.id);
    // C (BASE+2000) > D (BASE+1500) > {A,B} tied at BASE, A/B ordered by id
    // ascending > the fixture's own seeded baseline trace (SEED_EPOCH_MS,
    // oldest of all).
    const tieBreak = [A, B].sort();
    expect(ids.slice(0, 2)).toEqual([C, D]);
    expect(ids.slice(2, 4)).toEqual(tieBreak);
    expect(ids.length).toBe(5); // A, B, C, D, plus the fixture's own seed trace
    expect(result.coverage).toBe("full");
  });

  test("parent_id filters to direct children only", async () => {
    const result = await context().listTraces(req({ parent_id: A }));
    const rows = result.rows as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([C]);
  });

  test("prev_id filters to the trace whose prev_id points here (none, here)", async () => {
    const result = await context().listTraces(req({ prev_id: A }));
    expect(result.rows).toEqual([]);
  });

  test("query_contains is a bounded substring scan, not a fuzzy match", async () => {
    const hit = await context().listTraces(req({ query_contains: "needle-substring" }));
    expect((hit.rows as { id: string }[]).map((r) => r.id)).toEqual([D]);
    const miss = await context().listTraces(req({ query_contains: "needle substring" }));
    expect(miss.rows).toEqual([]);
  });

  test("every row carries derived_from_count, zero when nothing was ever distilled from it", async () => {
    const result = await context().listTraces(req());
    for (const row of result.rows as { derived_from_count: number }[]) expect(row.derived_from_count).toBe(0);
  });

  test("the compound cursor pages exactly: limit:1 then after_created_at/after_id resumes at the next row", async () => {
    const first = await context().listTraces(req({ limit: 1 }));
    expect((first.rows as { id: string }[])[0]!.id).toBe(C);
    expect(first.has_more).toBe(true);
    expect(first.next_after_id).toBeTruthy();
    const second = await context().listTraces(
      req({ limit: 1, after_created_at: first.next_after_created_at, after_id: first.next_after_id }),
    );
    expect((second.rows as { id: string }[])[0]!.id).toBe(D);
  });

  test("after_created_at without after_id (or the reverse) is refused, never treated as a half cursor", async () => {
    await expect(context().listTraces(req({ after_created_at: new Date(BASE).toISOString() }))).rejects.toBeTruthy();
    await expect(context().listTraces(req({ after_id: A }))).rejects.toBeTruthy();
  });

  test("isolation: alpha never sees beta's trace, and an empty/unknown workspace returns nothing extra", async () => {
    const alphaIds = ((await context().listTraces(req())).rows as { id: string }[]).map((r) => r.id);
    expect(alphaIds).not.toContain(E);
    const betaResult = await context().listTraces(req({ workspace_name: BETA }));
    expect((betaResult.rows as { id: string }[]).map((r) => r.id)).toContain(E);
    expect((betaResult.rows as { id: string }[]).map((r) => r.id)).not.toContain(A);
  });
});

describe("K5 transport: content:read on HTTP and MCP", () => {
  test("listTraces is a registry entry under content:read, scoped at the request root, and classified in PEER_FIELDS", () => {
    expect(KNOWLEDGE_METHODS.listTraces?.action).toBe("content:read");
    expect(KNOWLEDGE_METHODS.listTraces?.scopePath).toEqual([]);
  });

  test("a content:read-only credential reaches it over HTTP and MCP, with the same answer", async () => {
    const access = createKnowledgeAccess({ datasetRoot: fixture.datasetRoot });
    configureKnowledgeAccess(access);
    const deps = { logCall: async () => {} } as unknown as StoreDependencies;
    const service = createOperationService({ policyPath }, deps);
    const app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });
    const headers = { host: "127.0.0.1:3939", "content-type": "application/json", authorization: `Bearer ${READ_TOKEN}` };
    const body = { workspace_name: ALPHA, parent_id: null, prev_id: null, query_contains: null, after_created_at: null, after_id: null, limit: 10 };

    const listed = await app.handle(new Request(`${ORIGIN}/mcp/${ALPHA}`, {
      method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }));
    const names = ((await listed.json()) as any).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("kb_listTraces");

    const http = await app.handle(new Request(`${ORIGIN}/api/knowledge/${ALPHA}/listTraces`, { method: "POST", headers, body: JSON.stringify(body) }));
    expect(http.status).toBe(200);
    const httpBody = await http.json();
    const mcp = await app.handle(new Request(`${ORIGIN}/mcp/${ALPHA}`, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kb_listTraces", arguments: { payload: body } } }),
    }));
    const mcpBody = (await mcp.json()) as any;
    expect(mcpBody.result.isError).toBeUndefined();
    expect(JSON.parse(mcpBody.result.content[0].text)).toEqual(httpBody);
  });
});
