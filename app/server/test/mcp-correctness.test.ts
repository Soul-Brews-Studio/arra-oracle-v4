import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, Index, type Connection } from "@lancedb/lancedb";
import { text as mcpText } from "../src/mcp/protocol";
import {
  Bool,
  Field,
  FixedSizeList,
  Float32,
  Int64,
  Schema,
  TimestampMillisecond,
  Utf8,
} from "apache-arrow";

const ZERO_VECTOR = Array.from({ length: 384 }, () => 0);
const utf8 = (name: string, nullable = true) => new Field(name, new Utf8(), nullable);
const int64 = (name: string, nullable = false) => new Field(name, new Int64(), nullable);
const memorySchema = new Schema([
  utf8("id", false), utf8("name", false), utf8("workspace_name", false),
  utf8("session_name"), utf8("peer_name"), utf8("subject_peer_name"), utf8("type", false),
  utf8("content", false),
  new Field("embedding", new FixedSizeList(384, new Field("item", new Float32(), true)), true),
  new Field("created_at", new TimestampMillisecond(), false),
  new Field("valid_from", new TimestampMillisecond(), true),
  new Field("valid_to", new TimestampMillisecond(), true),
  utf8("sync_state", false), new Field("last_sync_at", new TimestampMillisecond(), true),
  int64("sync_attempts"), utf8("superseded_by"),
  new Field("superseded_at", new TimestampMillisecond(), true),
  new Field("is_active", new Bool(), false), utf8("h_metadata"), utf8("internal_metadata"),
]);
const callSchema = new Schema([
  utf8("id", false), utf8("workspace_name", false), utf8("session_name"), utf8("peer_name"),
  utf8("tool", false), utf8("status", false), int64("duration_ms"), utf8("h_metadata"),
  utf8("internal_metadata"), int64("created_at"),
]);

let dataDir: string;
let connection: Connection;
let store: typeof import("../src/db");
let calls: typeof import("../src/mcp/calls");
let mcp: typeof import("../src/mcp");
let app: (typeof import("../src/index"))["app"];
let embed: typeof import("../src/embed");
let originalFetch: typeof globalThis.fetch;
let originalDataDir: string | undefined;
let originalOllamaUrl: string | undefined;

const memory = (id: string, bank: string, type = "note", overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  workspace_name: bank,
  session_name: null,
  peer_name: null,
  subject_peer_name: null,
  type,
  content: `content ${id}`,
  embedding: null,
  created_at: new Date("2026-09-20T00:00:00.000Z"),
  valid_from: null,
  valid_to: null,
  sync_state: "pending",
  last_sync_at: null,
  sync_attempts: 0,
  superseded_by: null,
  superseded_at: null,
  is_active: true,
  h_metadata: null,
  internal_metadata: null,
  ...overrides,
});

const call = (
  id: string,
  bank: string,
  createdAt: number | bigint,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  workspace_name: bank,
  session_name: null,
  peer_name: null,
  tool: "recall",
  status: "ok",
  duration_ms: 3,
  h_metadata: JSON.stringify({ input: "{}", result: "[]" }),
  internal_metadata: null,
  created_at: createdAt,
  ...overrides,
});

async function rpc(bank: string, name: string, args: Record<string, unknown> = {}, ua = "") {
  return mcp.handleMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    bank,
    ua,
  );
}

function toolValue(response: Response) {
  return response.json().then((wire: any) => JSON.parse(wire.result.content[0].text));
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "arra-v4-mcp-test-"));
  originalDataDir = process.env.ARRA_DATA_DIR;
  originalOllamaUrl = process.env.OLLAMA_URL;
  process.env.ARRA_DATA_DIR = dataDir;
  process.env.OLLAMA_URL = "http://mock-embedder.invalid";
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch;

  connection = await connect(dataDir);
  const initialMemories = [
    ...Array.from({ length: 12 }, (_, i) => memory(`alpha-note-${String(i).padStart(2, "0")}`, "alpha")),
    memory("alpha-decision", "alpha", "decision", {
      session_name: "session-a",
      peer_name: "writer-a",
      subject_peer_name: "subject-a",
      sync_attempts: 9,
      valid_from: new Date("2026-09-01T00:00:00.000Z"),
      h_metadata: JSON.stringify({ visible: true }),
      internal_metadata: JSON.stringify({ source: "fixture" }),
    }),
    memory("beta-only", "beta"),
  ];
  const memories = await connection.createEmptyTable("memories", memorySchema);
  await memories.add(initialMemories);

  const callLog = await connection.createEmptyTable("mcp_calls", callSchema);
  await callLog.add([
    call("a-old", "alpha", 10),
    call("b-newest", "beta", 99),
    call("a-tie-a", "alpha", 50),
    call("a-tie-b", "alpha", 50),
    call("a-mid", "alpha", 40, { status: "error", duration_ms: 7 }),
  ]);

  store = await import("../src/db");
  calls = await import("../src/mcp/calls");
  mcp = await import("../src/mcp");
  ({ app } = await import("../src/index"));
  embed = await import("../src/embed");
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.ARRA_DATA_DIR;
  else process.env.ARRA_DATA_DIR = originalDataDir;
  if (originalOllamaUrl === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = originalOllamaUrl;
  await rm(dataDir, { recursive: true, force: true });
});

describe("bank-scoped observability", () => {
  test("call log orders the complete eligible set before limit with a stable id tie-break", async () => {
    const rows = await calls.recent("alpha", 2);
    expect(rows.map((row: any) => row.id)).toEqual(["a-tie-b", "a-tie-a"]);
    expect(rows.every((row: any) => row.workspace_name === "alpha")).toBe(true);
  });

  test("call statistics and memory statistics cannot cross banks", async () => {
    expect(await calls.aggregate("alpha")).toMatchObject({ total: 4 });
    expect(await calls.aggregate("beta")).toMatchObject({ total: 1 });
    expect(await store.stats("alpha")).toMatchObject({ rows: 13, unembedded: 13 });
    expect(await store.stats("beta")).toMatchObject({ rows: 1, unembedded: 1 });
  });

  test("scope is required by store and audit operations", async () => {
    await expect((calls.recent as any)(undefined, 2)).rejects.toThrow("bank is required");
    await expect((calls.aggregate as any)("")).rejects.toThrow("bank is required");
    await expect((store.stats as any)(undefined)).rejects.toThrow("bank is required");
    const response = await mcp.handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      " ",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: "bank is required" } });
  });

  test("bank_info, call_log, and call_stats dispatch the route bank", async () => {
    expect(await toolValue(await rpc("beta", "bank_info"))).toMatchObject({ bank: "beta", rows: 1 });
    expect(await toolValue(await rpc("beta", "call_stats"))).toMatchObject({ total: 2 });
    const rows = await toolValue(await rpc("beta", "call_log", { limit: 10 }));
    expect(rows.every((row: any) => row.workspace_name === "beta")).toBe(true);
  });
});

describe("audit identity and wire safety", () => {
  test("status reports active foundation separately from proposed target contract", async () => {
    const result = await toolValue(await rpc("alpha", "status"));
    expect(result.contract).toMatchObject({
      manifest: "arra-v4-target/1",
      status: "proposed-not-active",
      active_tables: 15,
      target_tables: 19,
    });
  });

  test("transport user-agent is never persisted as a peer identity", async () => {
    await rpc("alpha", "status", {}, "pretend-registered-peer/1.0");
    const table = await connection.openTable("mcp_calls");
    await table.checkoutLatest();
    const rows = await table.query().where("workspace_name = 'alpha'").toArray();
    const latest = rows.find((row: any) => row.tool === "status" && row.internal_metadata);
    expect(latest.peer_name).toBeNull();
    expect(JSON.parse(latest.internal_metadata)).toMatchObject({
      transport: { user_agent: "pretend-registered-peer/1.0" },
    });
  });

  test("secret-bearing values are redacted before persistence and truncation", async () => {
    const secret = `Bearer ${"s".repeat(2500)}`;
    await calls.logCall({
      tool: "remember",
      input: { authorization: secret, nested: { api_key: "key-123", safe: "kept" } },
      status: "error",
      result: `failed authorization=${secret}`,
      duration_ms: 1,
      workspace_name: "alpha",
      client_label: secret,
    });
    const table = await connection.openTable("mcp_calls");
    await table.checkoutLatest();
    const rows = await table.query().where("workspace_name = 'alpha' AND tool = 'remember'").toArray();
    const raw = `${rows.at(-1)?.h_metadata} ${rows.at(-1)?.internal_metadata}`;
    expect(raw).not.toContain("key-123");
    expect(raw).not.toContain("ssssssss");
    expect(raw).toContain("[REDACTED]");
    expect(raw).toContain("kept");
  });

  test("BigInt-backed rows are safe on MCP and HTTP JSON wires", async () => {
    const table = await connection.openTable("mcp_calls");
    await table.add([call("unsafe-int", "alpha", 9007199254740993n, {
      duration_ms: 9007199254740993n,
    })]);
    const audit = await toolValue(await rpc("alpha", "call_log", { limit: 10 }));
    expect(() => JSON.stringify(audit)).not.toThrow();
    expect(audit.find((row: any) => row.id === "unsafe-int")?.duration_ms).toBe("9007199254740993");
    expect(audit.find((row: any) => row.id === "unsafe-int")?.at).toBe("9007199254740993");
    const block = mcpText({ safe: 42n, unsafe: 9007199254740993n });
    expect(JSON.parse(block.content[0].text)).toEqual({ safe: 42, unsafe: "9007199254740993" });

    const response = await app.handle(new Request("http://localhost/api/memories?bank=alpha&limit=20"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(() => JSON.stringify(body)).not.toThrow();

    const health = await app.handle(new Request("http://localhost/api/health?bank=alpha"));
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(() => JSON.stringify(healthBody)).not.toThrow();
  });
});

describe("memory correctness", () => {
  test("list applies filters before limit and preserves attribution fields", async () => {
    const rows = await toolValue(await rpc("alpha", "list_memories", { type: "decision", limit: 1 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "alpha-decision",
      session_name: "session-a",
      peer_name: "writer-a",
      subject_peer_name: "subject-a",
      created_at: Date.parse("2026-09-20T00:00:00.000Z"),
      valid_from: Date.parse("2026-09-01T00:00:00.000Z"),
      valid_to: null,
      superseded_by: null,
      h_metadata: JSON.stringify({ visible: true }),
    });
  });

  test("internal metadata is omitted from public HTTP and MCP memory responses", async () => {
    const list = await toolValue(await rpc("alpha", "list_memories", { type: "decision" }));
    const get = await toolValue(await rpc("alpha", "get_memory", { id: "alpha-decision" }));
    const http = await (await app.handle(new Request("http://localhost/api/memories?bank=alpha"))).json();
    for (const row of [...list, get, ...http]) {
      expect(row).not.toHaveProperty("internal_metadata");
      expect(JSON.stringify(row)).not.toContain('"source":"fixture"');
    }
  });

  test("get_memory uses direct id+bank lookup rather than a capped list scan", async () => {
    const table = await connection.openTable("memories");
    await table.add([
      ...Array.from({ length: 1005 }, (_, i) => memory(`bulk-${String(i).padStart(4, "0")}`, "crowded")),
      memory("target-after-cap", "crowded"),
    ]);
    expect(await toolValue(await rpc("crowded", "get_memory", { id: "target-after-cap" }))).toMatchObject({
      id: "target-after-cap",
      workspace_name: "crowded",
    });
  });

  test("remember propagates subject attribution and ACKs without any model I/O", async () => {
    let embedCalls = 0;
    globalThis.fetch = (() => {
      embedCalls++;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const operation = rpc("alpha", "remember", {
        name: "save-first",
        content: "canonical text lands before embeddings",
        peer_name: "writer-b",
        subject_peer_name: "subject-b",
      });
    const response = await Promise.race([
      operation,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("remember waited on embedder")), 2000)),
    ]);
    const value = await toolValue(response);
    expect(embedCalls).toBe(0);
    expect(value).toMatchObject({ embedded: false, sync_state: "pending" });
    const saved = await store.getById("alpha", value.id);
    expect(saved).toMatchObject({ peer_name: "writer-b", subject_peer_name: "subject-b" });
  });

  test("backfill records failed attempts with int64 counters and can later succeed", async () => {
    globalThis.fetch = (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch;
    await expect(store.backfill(1)).rejects.toThrow("embed failed: 503");
    const table = await connection.openTable("memories");
    await table.checkoutLatest();
    expect(await table.countRows("sync_state = 'failed' AND sync_attempts = 1")).toBeGreaterThan(0);

    globalThis.fetch = (async () => Response.json({ embeddings: [ZERO_VECTOR] })) as unknown as typeof fetch;
    expect(await store.backfill(1)).toMatchObject({ embedded: 1 });
    await table.checkoutLatest();
    expect(await table.countRows("sync_state = 'synced' AND embedding IS NOT NULL")).toBeGreaterThan(0);
  });
});

describe("boundary validation", () => {
  test("the ignored workspace route is rejected explicitly", async () => {
    const response = await app.handle(
      new Request("http://localhost/mcp/alpha/ignored-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("not supported") });
  });

  test("unscoped HTTP reads fail closed and MCP numeric bounds match the CLI", async () => {
    for (const path of ["/api/health", "/api/memories", "/api/search?q=memory"]) {
      expect((await app.handle(new Request(`http://localhost${path}`))).status).toBe(400);
    }
    expect((await app.handle(new Request("http://localhost/api/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "unscoped", content: "must not default into a bank" }),
    }))).status).toBe(400);
    for (const limit of [0, 1.5, 1001, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await rpc("alpha", "list_memories", { limit });
      const wire = await response.json() as any;
      expect(wire.result.isError).toBe(true);
      expect(wire.result.content[0].text).toContain("safe integer between 1 and 1000");
    }
  });

  test("HTTP and MCP reject permissive coercions, invalid enums, and malformed bodies", async () => {
    for (const path of [
      "/api/memories?bank=%20&limit=1",
      "/api/memories?bank=alpha&limit=NaN",
      "/api/memories?bank=alpha&limit=1.5",
      "/api/memories?bank=alpha&limit=1001",
      "/api/search?bank=alpha&q=x&mode=hybrid",
      "/api/search?bank=alpha&q=x&limit=true",
    ]) {
      expect((await app.handle(new Request(`http://localhost${path}`))).status).toBe(400);
    }
    for (const body of [null, [], { workspace_name: "alpha", name: "n", content: 3 }, {
      workspace_name: "alpha", name: "n", content: "c", subject_peer_name: false,
    }]) {
      expect((await app.handle(new Request("http://localhost/api/memories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }))).status).toBe(400);
    }

    const invalidCalls = [
      ["recall", { query: "x", mode: "hybrid" }],
      ["recall", { query: "x", limit: true }],
      ["call_log", { status: "maybe" }],
      ["list_memories", { is_active: "false" }],
      ["list_memories", { sync_state: "unknown" }],
      ["remember", { content: 123 }],
      ["remember", { content: "ok", type: " " }],
    ] as const;
    for (const [name, args] of invalidCalls) {
      const wire = await (await rpc("alpha", name, args)).json() as any;
      expect(wire.result.isError).toBe(true);
    }

    const malformed = await mcp.handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: [] } },
      "alpha",
    );
    expect((await malformed.json() as any).result.isError).toBe(true);
    expect((await calls.recent("alpha", 100, "error")).some((row: any) =>
      row.tool === "status" && row.result === "arguments must be an object")).toBe(true);
  });

  test("embedding rejects null, non-finite, wrong-count, and wrong-dimension vectors", async () => {
    for (const embeddings of [
      [[...ZERO_VECTOR.slice(0, -1)]],
      [[...ZERO_VECTOR.slice(0, -1), null]],
      [[...ZERO_VECTOR.slice(0, -1), Number.POSITIVE_INFINITY]],
      [[...ZERO_VECTOR.slice(0, -1), Number.MAX_VALUE]],
      [ZERO_VECTOR, ZERO_VECTOR],
    ]) {
      globalThis.fetch = (async () => Response.json({ embeddings })) as unknown as typeof fetch;
      await expect(embed.embed(["one"])).rejects.toThrow();
    }
  });
});


describe("keyword-search startup readiness", () => {
  test("empty datasets can build an ICU index and return empty results", async () => {
    const empty = await connection.createEmptyTable("empty_search_fixture", memorySchema);
    await empty.createIndex("content", { config: Index.fts({ baseTokenizer: "icu" }) });
    expect(await empty.search("schema", "fts").toArray()).toEqual([]);
  });
  test("startup index initialization is idempotent and new rows are searchable with bank scope", async () => {
    await store.ensureFtsIndex(false);
    const table = await store.db();
    const version = await table.version();
    await store.ensureFtsIndex(false);
    expect(await table.version()).toBe(version);
    const alpha = await store.insert({ name: "search-alpha", workspace_name: "alpha", content: "uniqueproof ความทรงจำ" });
    await store.insert({ name: "search-beta", workspace_name: "beta", content: "uniqueproof ความทรงจำ" });
    const rows = await toolValue(await rpc("alpha", "recall", { query: "uniqueproof", mode: "text" }));
    expect(rows.map((r: any) => r.id)).toEqual([alpha.id]);
    const response = await app.handle(new Request("http://localhost/api/search?bank=alpha&q=uniqueproof"));
    expect(response.status).toBe(200);
    expect((await response.json()).rows.map((r: any) => r.id)).toEqual([alpha.id]);
  });
});
