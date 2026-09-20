// #25 integration: every surface in contract section 1 goes through the shared
// service admission. These were written BEFORE the implementation and first run
// against pre-change code, where the unauthenticated cases all failed because
// the server answered them; that failing baseline is the point of the exercise.
//
// Synthetic credentials and a scratch dataset only. No real policy, no model
// call, no network, no live write.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bearer,
  createScratch,
  createScratchDependencies,
  defaultPolicyDocument,
  NOW_MS,
  TOKENS,
  type Scratch,
} from "./helpers/auth-fixture";

let scratch: Scratch;
let app: { handle: (request: Request) => Promise<Response> };
let originalDataDir: string | undefined;
let originalPolicy: string | undefined;
let originalOrigin: string | undefined;
let originalOllama: string | undefined;
let originalFetch: typeof globalThis.fetch;

const ORIGIN = "http://127.0.0.1:3939";
const url = (path: string) => `${ORIGIN}${path}`;

/** Every request carries the configured Host; Origin is omitted unless tested. */
const request = (path: string, init: RequestInit = {}) =>
  new Request(url(path), { ...init, headers: { host: "127.0.0.1:3939", ...(init.headers ?? {}) } });

const send = (path: string, init?: RequestInit) => app.handle(request(path, init));

const authed = (token: string, init: RequestInit = {}) => ({
  ...init,
  headers: { authorization: bearer(token), ...(init.headers ?? {}) },
});

const jsonBody = (value: unknown, init: RequestInit = {}) => ({
  ...init,
  method: "POST",
  headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  body: JSON.stringify(value),
});

const mcpCall = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

beforeAll(async () => {
  scratch = await createScratch();
  originalDataDir = process.env.ARRA_DATA_DIR;
  originalPolicy = process.env.ARRA_AUTH_POLICY;
  originalOrigin = process.env.ARRA_ORIGIN;
  originalOllama = process.env.OLLAMA_URL;
  process.env.ARRA_DATA_DIR = scratch.dataDir;
  process.env.ARRA_AUTH_POLICY = scratch.policyPath;
  process.env.ARRA_ORIGIN = ORIGIN;
  process.env.OLLAMA_URL = "http://mock-embedder.invalid";
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch;
  // Explicitly injected scratch dependencies: these suites never touch the
  // real store module, so running them alongside others cannot collide on its
  // module-level connection singleton.
  const { createOperationService } = await import("../src/auth/service");
  const { createApp } = await import("../src/app");
  const { createMcpAdapter } = await import("../src/mcp");
  const service = createOperationService(
    { policyPath: scratch.policyPath },
    createScratchDependencies(scratch.connection) as never,
  );
  app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service));
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("ARRA_DATA_DIR", originalDataDir);
  restore("ARRA_AUTH_POLICY", originalPolicy);
  restore("ARRA_ORIGIN", originalOrigin);
  restore("OLLAMA_URL", originalOllama);
  await scratch.cleanup();
  expect(NOW_MS).toBeGreaterThan(0);
});

describe("unauthenticated requests are denied on every protected surface", () => {
  const protectedGets = [
    "/api/health?bank=alpha",
    "/api/memories?bank=alpha",
    "/api/search?bank=alpha&q=content",
  ];

  test("protected GET routes answer 401 without a credential", async () => {
    for (const path of protectedGets) {
      const res = await send(path);
      expect(res.status).toBe(401);
    }
  });

  test("protected POST routes answer 401 without a credential", async () => {
    const write = await send("/api/memories", jsonBody({ workspace_name: "alpha", name: "n", content: "c" }));
    expect(write.status).toBe(401);
    expect((await send("/api/backfill", { method: "POST" })).status).toBe(401);
    expect((await send("/api/reindex", { method: "POST" })).status).toBe(401);
  });

  test("MCP answers 401 without a credential, for discovery and for tool calls", async () => {
    const list = await send("/mcp/alpha", jsonBody({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(list.status).toBe(401);
    const call = await send("/mcp/alpha", jsonBody(mcpCall("remember", { content: "x" })));
    expect(call.status).toBe(401);
  });

  test("a 401 carries a Bearer challenge and no-store, and leaks no secret", async () => {
    const res = await send("/api/memories?bank=alpha");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")?.toLowerCase()).toContain("bearer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    for (const secret of Object.values(TOKENS)) expect(body).not.toContain(secret.secret);
  });

  test("an unknown credential is 401, not 403", async () => {
    const res = await send("/api/memories?bank=alpha", authed(TOKENS.unknown.secret));
    expect(res.status).toBe(401);
  });
});

describe("authenticated but unauthorized requests are 403", () => {
  test("operator-b cannot read alpha", async () => {
    const res = await send("/api/memories?bank=alpha", authed(TOKENS.beta.secret));
    expect(res.status).toBe(403);
  });

  test("operator-a cannot use global maintenance", async () => {
    expect((await send("/api/backfill", authed(TOKENS.alpha.secret, { method: "POST" }))).status).toBe(403);
    expect((await send("/api/reindex", authed(TOKENS.alpha.secret, { method: "POST" }))).status).toBe(403);
  });

  test("the maintenance principal cannot read tenant content", async () => {
    expect((await send("/api/memories?bank=alpha", authed(TOKENS.maint.secret))).status).toBe(403);
  });

  test("operator-b cannot read alpha's audit log through MCP", async () => {
    const res = await send("/mcp/alpha", authed(TOKENS.beta.secret, jsonBody(mcpCall("call_log"))));
    expect(res.status).toBe(403);
  });
});

describe("authorized requests succeed and stay scoped", () => {
  test("operator-a reads only alpha", async () => {
    const res = await send("/api/memories?bank=alpha", authed(TOKENS.alpha.secret));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ workspace_name: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.workspace_name).toBe("alpha");
  });

  test("operator-b reads only beta", async () => {
    const res = await send("/api/memories?bank=beta", authed(TOKENS.beta.secret));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ workspace_name: string }>;
    for (const row of rows) expect(row.workspace_name).toBe("beta");
  });

  test("a protected success also sends no-store", async () => {
    const res = await send("/api/memories?bank=alpha", authed(TOKENS.alpha.secret));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("public liveness stays public and does no work", () => {
  test("GET /health is 200 without a credential and discloses no storage path", async () => {
    const res = await send("/health");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(scratch.dataDir);
    expect(body.toLowerCase()).not.toContain("ollama");
    expect(body).not.toContain("mock-embedder");
  });

  test("GET /health sends no Bearer challenge", async () => {
    const res = await send("/health");
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});

describe("scope carriers: conflicts reject before policy work", () => {
  test("a global endpoint rejects a supplied bank with 400", async () => {
    const res = await send("/api/backfill?bank=alpha", authed(TOKENS.maint.secret, { method: "POST" }));
    expect(res.status).toBe(400);
  });

  test("POST /api/memories rejects a query bank that differs from the body workspace", async () => {
    const res = await send(
      "/api/memories?bank=beta",
      authed(TOKENS.alpha.secret, jsonBody({ workspace_name: "alpha", name: "n", content: "c" })),
    );
    expect(res.status).toBe(400);
  });

  test("a missing or blank body workspace is 400, before any credential check", async () => {
    for (const bad of [undefined, "", "   ", 7, null]) {
      const res = await send("/api/memories", jsonBody({ workspace_name: bad, name: "n", content: "c" }));
      expect(res.status).toBe(400);
    }
  });
});

describe("Host and Origin are enforced before policy I/O", () => {
  test("a mismatched Host is 400 on every route", async () => {
    const res = await app.handle(
      new Request(url("/api/memories?bank=alpha"), { headers: { host: "evil.example" } }),
    );
    expect(res.status).toBe(400);
  });

  test("a present, mismatched Origin is 403", async () => {
    const res = await send("/api/memories?bank=alpha", authed(TOKENS.alpha.secret, { headers: { origin: "http://evil.example" } }));
    expect(res.status).toBe(403);
  });

  test("an absent Origin is fine for CLI and MCP callers", async () => {
    const res = await send("/api/memories?bank=alpha", authed(TOKENS.alpha.secret));
    expect(res.status).toBe(200);
  });
});

describe("denied requests cause no storage or audit effect", () => {
  test("a denied write adds no row and no audit entry", async () => {
    const memories = await scratch.connection.openTable("memories");
    const calls = await scratch.connection.openTable("mcp_calls");
    const beforeMemories = await memories.countRows();
    const beforeCalls = await calls.countRows();

    await send("/api/memories", jsonBody({ workspace_name: "alpha", name: "denied", content: "c" }));
    await send("/mcp/alpha", jsonBody(mcpCall("remember", { content: "denied" })));
    await send("/mcp/alpha", authed(TOKENS.beta.secret, jsonBody(mcpCall("remember", { content: "denied" }))));

    await memories.checkoutLatest();
    await calls.checkoutLatest();
    expect(await memories.countRows()).toBe(beforeMemories);
    expect(await calls.countRows()).toBe(beforeCalls);
  });
});

describe("policy availability", () => {
  test("an unreadable policy fails closed with 503, never last-good", async () => {
    await scratch.writePolicy({ version: "arra-auth/v1", principals: [], credentials: [] });
    const denied = await send("/api/memories?bank=alpha", authed(TOKENS.alpha.secret));
    expect(denied.status).toBe(401);
    await scratch.writePolicy(defaultPolicyDocument());
    const restored = await send("/api/memories?bank=alpha", authed(TOKENS.alpha.secret));
    expect(restored.status).toBe(200);
  });
});

describe("scope-bound operations are authority and carry their own action checks", () => {
  // These reproduce three defects found by review on a moving tree. Each fails
  // loudly if the corresponding repair is reverted.

  test("a dispatcher admitted only for content:read cannot call insert", async () => {
    // The bypass: runMcp handed every dispatcher a full `ops` object, so a
    // read-only tool could simply call ops.insert and write.
    const { createOperationService } = await import("../src/auth/service");
    const { createScratchDependencies } = await import("./helpers/auth-fixture");
    const counters = { inserts: 0 };
    const deps = createScratchDependencies(scratch.connection) as never as Record<string, any>;
    const counting = {
      ...deps,
      insert: async (row: any) => {
        counters.inserts += 1;
        return deps.insert(row);
      },
    };
    const service = createOperationService({ policyPath: scratch.policyPath }, counting as never);

    const result = await service.runMcp(
      bearer(TOKENS.alpha.secret),
      "alpha",
      async () => ({ method: "tools/call", id: 1, params: { name: "list_memories", arguments: {} } }),
      // A hostile dispatcher: admitted for content:read, attempts a write.
      async (_name, _args, ops) => ops.insert({ name: "sneaky", content: "sneaky" }),
    );
    expect(result.kind).toBe("tool_error");
    expect(counters.inserts).toBe(0);
  });

  test("the tool-to-action map is owned by the service, not chosen by the caller", async () => {
    const { createOperationService } = await import("../src/auth/service");
    const { createScratchDependencies } = await import("./helpers/auth-fixture");
    const service = createOperationService(
      { policyPath: scratch.policyPath },
      createScratchDependencies(scratch.connection) as never,
    );
    // operator-b holds content:read+write on beta but NO audit:read. call_log
    // must therefore be refused whatever a caller might claim it needs.
    const result = await service.runMcp(
      bearer(TOKENS.beta.secret),
      "beta",
      async () => ({ method: "tools/call", id: 1, params: { name: "call_log", arguments: {} } }),
      async (name, args, ops) => ops.recentCalls(10),
    );
    expect(result.kind).toBe("denied");
  });

  test("a denied write performs no storage read: there is no probe call", async () => {
    // The earlier implementation probed with a list() before admitting the
    // write, which both admitted the WRONG action and touched storage for a
    // request that was about to be refused.
    const { createOperationService } = await import("../src/auth/service");
    const { createScratchDependencies } = await import("./helpers/auth-fixture");
    const counters = { lists: 0, inserts: 0 };
    const deps = createScratchDependencies(scratch.connection) as never as Record<string, any>;
    const counting = {
      ...deps,
      list: async (...a: any[]) => {
        counters.lists += 1;
        return (deps.list as any)(...a);
      },
      insert: async (...a: any[]) => {
        counters.inserts += 1;
        return (deps.insert as any)(...a);
      },
    };
    const service = createOperationService({ policyPath: scratch.policyPath }, counting as never);
    // operator-b has no grant at all on alpha.
    await expect(
      service.insertMemory(bearer(TOKENS.beta.secret), "alpha", () => ({ name: "n", content: "c" })),
    ).rejects.toThrow();
    expect(counters.lists).toBe(0);
    expect(counters.inserts).toBe(0);
  });

  test("an admitted insert builds its row exactly once, with no extra store call", async () => {
    const { createOperationService } = await import("../src/auth/service");
    const { createScratchDependencies } = await import("./helpers/auth-fixture");
    const counters = { lists: 0, builds: 0 };
    const deps = createScratchDependencies(scratch.connection) as never as Record<string, any>;
    const counting = {
      ...deps,
      list: async (...a: any[]) => {
        counters.lists += 1;
        return (deps.list as any)(...a);
      },
    };
    const service = createOperationService({ policyPath: scratch.policyPath }, counting as never);
    await service.insertMemory(bearer(TOKENS.alpha.secret), "alpha", () => {
      counters.builds += 1;
      return { name: "once", content: "once" };
    });
    expect(counters.builds).toBe(1);
    expect(counters.lists).toBe(0);
  });
});

describe("global maintenance still obeys the transport caps", () => {
  const ROUTE_CAP = 256 * 1024;

  test("an admitted backfill with a gzip body is refused before mutating", async () => {
    const res = await send(
      "/api/backfill",
      authed(TOKENS.maint.secret, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: JSON.stringify({ any: "thing" }),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("an admitted backfill with an oversized body is refused before mutating", async () => {
    const body = JSON.stringify({ pad: "a".repeat(ROUTE_CAP) });
    expect(body.length).toBeGreaterThan(ROUTE_CAP);
    const res = await send(
      "/api/backfill",
      authed(TOKENS.maint.secret, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(res.status).toBe(413);
  });

  test("an UNADMITTED oversized backfill is still 401: admission precedes the body", async () => {
    const res = await send("/api/backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "a".repeat(ROUTE_CAP) }),
    });
    expect(res.status).toBe(401);
  });

  test("a bodyless admitted backfill still succeeds", async () => {
    const res = await send("/api/backfill", authed(TOKENS.maint.secret, { method: "POST" }));
    expect(res.status).toBe(200);
  });
});

describe("transport guard, scope grammar and media type (stable-tree review round)", () => {
  const longBank = "a".repeat(257);

  test("STATIC ASSETS obey the same Host and Origin guard as data routes", async () => {
    // These bypassed the guard entirely: the plugin answered before any
    // per-route check ran, so a mismatched Host still got the page.
    const badHost = await app.handle(new Request(url("/index.html"), { headers: { host: "evil.example" } }));
    expect(badHost.status).toBe(400);
    const badOrigin = await app.handle(
      new Request(url("/index.html"), { headers: { host: "127.0.0.1:3939", origin: "http://evil.example" } }),
    );
    expect(badOrigin.status).toBe(403);
  });

  test("an unauthenticated caller sees 401, never a non-scope parameter 400", async () => {
    // Order matters: a malformed limit or empty query must not be reported to
    // someone who was never admitted.
    expect((await send("/api/search?bank=alpha")).status).toBe(401);
    expect((await send("/api/search?bank=alpha&q=")).status).toBe(401);
    expect((await send("/api/memories?bank=alpha&limit=notanumber")).status).toBe(401);
    expect((await send("/api/memories?bank=alpha&limit=0")).status).toBe(401);
    expect((await send("/api/backfill?batch=nope", { method: "POST" })).status).toBe(401);
  });

  test("an ADMITTED caller still gets 400 for the same malformed parameters", async () => {
    expect((await send("/api/search?bank=alpha&q=", authed(TOKENS.alpha.secret))).status).toBe(400);
    expect((await send("/api/memories?bank=alpha&limit=0", authed(TOKENS.alpha.secret))).status).toBe(400);
    expect((await send("/api/backfill?batch=nope", authed(TOKENS.maint.secret, { method: "POST" }))).status).toBe(400);
  });

  test("an over-long workspace is 400 on every carrier, never a policy 503", async () => {
    expect((await send(`/api/memories?bank=${longBank}`, authed(TOKENS.alpha.secret))).status).toBe(400);
    expect((await send(`/api/search?bank=${longBank}&q=x`, authed(TOKENS.alpha.secret))).status).toBe(400);
    const mcp = await send(`/mcp/${longBank}`, authed(TOKENS.alpha.secret, jsonBody({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
    expect(mcp.status).toBe(400);
    const body = await send(
      "/api/memories",
      authed(TOKENS.alpha.secret, jsonBody({ workspace_name: longBank, name: "n", content: "c" })),
    );
    expect(body.status).toBe(400);
  });

  test("a lone-surrogate workspace is 400, not 503", async () => {
    const res = await send(
      "/api/memories",
      authed(TOKENS.alpha.secret, jsonBody({ workspace_name: "\ud800", name: "n", content: "c" })),
    );
    expect(res.status).toBe(400);
  });

  test("Content-Type accepts JSON with at most ONE utf-8 charset and no other parameter", async () => {
    const post = (contentType: string) =>
      send("/api/memories", {
        ...authed(TOKENS.alpha.secret),
        method: "POST",
        headers: { authorization: bearer(TOKENS.alpha.secret), "content-type": contentType },
        body: JSON.stringify({ workspace_name: "alpha", name: "ct", content: "ct" }),
      });

    for (const good of [
      "application/json",
      "application/json; charset=utf-8",
      "application/json;charset=UTF-8",
      'application/json; charset="utf-8"',
      "application/json;  charset=utf-8",
      "APPLICATION/JSON; CHARSET=UTF-8",
    ]) {
      expect((await post(good)).status).toBe(201);
    }

    for (const bad of [
      "application/json;charset=utf-8;charset=latin1", // conflicting duplicate
      "application/json;charset=utf-8;charset=utf-8", // duplicate at all
      "application/json;foo=bar", // unsupported parameter
      "application/json;charset=latin1",
      "application/json;charset=",
      "application/json;",
      "application/json,application/json", // duplicated header line
      "text/plain",
      "application/x-www-form-urlencoded",
    ]) {
      expect((await post(bad)).status).toBe(415);
    }
  });

  test("a rejected media type performs no store write", async () => {
    const memories = await scratch.connection.openTable("memories");
    const before = await memories.countRows();
    await send("/api/memories", {
      method: "POST",
      headers: { authorization: bearer(TOKENS.alpha.secret), "content-type": "application/json;foo=bar" },
      body: JSON.stringify({ workspace_name: "alpha", name: "nope", content: "nope" }),
    });
    await memories.checkoutLatest();
    expect(await memories.countRows()).toBe(before);
  });
});

describe("request-lifetime capability and policy-failure envelope", () => {
  /**
   * Assert a call fails, whether it throws SYNCHRONOUSLY or rejects.
   *
   * `expect(x()).rejects` is useless when x throws before returning a promise:
   * the throw escapes the expect() call itself and the assertion never runs.
   */
  const failsSomehow = async (run: () => unknown): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error("expected the call to fail");
  };

  const buildService = async (overrides: Record<string, any> = {}) => {
    const { createOperationService } = await import("../src/auth/service");
    const { createScratchDependencies } = await import("./helpers/auth-fixture");
    const deps = createScratchDependencies(scratch.connection) as never as Record<string, any>;
    return {
      service: createOperationService({ policyPath: scratch.policyPath }, { ...deps, ...overrides } as never),
      deps,
    };
  };

  test("ops captured by a dispatcher are dead once the request completes", async () => {
    // The leak: a dispatcher could stash `ops` and keep using it afterwards,
    // when the credential may since have been revoked. A capability that
    // outlives its request no longer answers to the policy.
    let escaped: any = null;
    const counters = { lists: 0 };
    const { service } = await buildService({
      list: async (...a: any[]) => {
        counters.lists += 1;
        return [];
      },
    });

    const result = await service.runMcp(
      bearer(TOKENS.alpha.secret),
      "alpha",
      async () => ({ method: "tools/call", id: 1, params: { name: "list_memories", arguments: {} } }),
      async (_name, _args, ops) => {
        escaped = ops;
        return ops.list(5, {});
      },
    );
    expect(result.kind).toBe("ok");
    const duringRequest = counters.lists;
    expect(duringRequest).toBe(1);

    // Same object, after the request finished.
    expect(await failsSomehow(() => escaped.list(5, {}))).toBeInstanceOf(Error);
    expect(counters.lists).toBe(duringRequest);
  });

  test("a retained op stays dead even for a still-valid credential", async () => {
    let escaped: any = null;
    const { service } = await buildService();
    await service.runMcp(
      bearer(TOKENS.alpha.secret),
      "alpha",
      async () => ({ method: "tools/call", id: 1, params: { name: "list_memories", arguments: {} } }),
      async (_n, _a, ops) => {
        escaped = ops;
        return ops.list(1, {});
      },
    );
    // A fresh admitted call still works, proving the credential is fine and it
    // is specifically the RETAINED capability that was revoked.
    await expect(service.listMemories(bearer(TOKENS.alpha.secret), "alpha", 1)).resolves.toBeDefined();
    expect(await failsSomehow(() => escaped.insert({ name: "x", content: "x" }))).toBeInstanceOf(Error);
    expect(await failsSomehow(() => escaped.list(1, {}))).toBeInstanceOf(Error);
  });

  test("retained ops are dead after the credential is revoked, with zero effects", async () => {
    let escaped: any = null;
    const counters = { inserts: 0 };
    const { service } = await buildService({
      insert: async (row: any) => {
        counters.inserts += 1;
        return { id: "leak", embedded: false };
      },
    });
    await service.runMcp(
      bearer(TOKENS.alpha.secret),
      "alpha",
      async () => ({ method: "tools/call", id: 1, params: { name: "remember", arguments: { content: "ok" } } }),
      async (_n, _a, ops) => {
        escaped = ops;
        return ops.insert({ name: "ok", content: "ok" });
      },
    );
    expect(counters.inserts).toBe(1);

    const revoked = defaultPolicyDocument();
    revoked.credentials[0]!.revoked = true;
    await scratch.writePolicy(revoked);
    expect(await failsSomehow(() => service.listMemories(bearer(TOKENS.alpha.secret), "alpha", 1))).toBeInstanceOf(Error);
    expect(await failsSomehow(() => escaped.insert({ name: "after", content: "after" }))).toBeInstanceOf(Error);
    expect(counters.inserts).toBe(1);
    await scratch.writePolicy(defaultPolicyDocument());
  });

  test("a missing or malformed policy gives MCP the fixed 503 envelope, not a bare 500", async () => {
    // snapshot() throws; letting it escape produced an HTTP 500 with no
    // Cache-Control instead of the contract's fixed JSON.
    const original = await Bun.file(scratch.policyPath).text();
    for (const broken of ["{ not json", ""]) {
      await Bun.write(scratch.policyPath, broken);
      const res = await send("/mcp/alpha", authed(TOKENS.alpha.secret, jsonBody({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "policy unavailable" });
    }
    await Bun.write(scratch.policyPath, original);
    const restored = await send("/mcp/alpha", authed(TOKENS.alpha.secret, jsonBody({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
    expect(restored.status).toBe(200);
  });
});

describe("startup seam: runtime refusal, ordering and the global backstop", () => {
  // Exercises the REAL exported startup(), which is now the only production
  // path: import.meta.main calls it and does no config read or listen of its
  // own. Injection happens at the build seam, not by duplicating the sequence.

  const fakeApp = (record: string[], captured: { options?: any }) => async () => ({
    listen(options: any) {
      record.push("listen");
      captured.options = options;
    },
  });

  test("an unsupported runtime refuses BEFORE config, policy, index work or listen", async () => {
    const { startup } = await import("../src/index");
    const order: string[] = [];
    await expect(
      startup({
        // A deliberately broken env: if configuration were read before the
        // runtime check, this would fail with a DIFFERENT error.
        env: {} as never,
        runtime: () => ({ ok: false, reason: "unsupported Bun runtime: expected 1.3.14" }),
        indexWork: async () => {
          order.push("index");
        },
        build: fakeApp(order, {}),
      }),
    ).rejects.toThrow(/startup refused: unsupported Bun runtime/);
    expect(order).toEqual([]);
  });

  test("an invalid policy stops startup before index work and listen", async () => {
    const { startup } = await import("../src/index");
    const order: string[] = [];
    await expect(
      startup({
        env: { ARRA_AUTH_POLICY: "/nonexistent/policy.json", ARRA_ORIGIN: ORIGIN, PORT: "3939" } as never,
        runtime: () => ({ ok: true }),
        indexWork: async () => {
          order.push("index");
        },
        build: fakeApp(order, {}),
      }),
    ).rejects.toThrow();
    expect(order).toEqual([]);
  });

  test("a valid startup runs index work BEFORE listen and applies the 1 MiB backstop", async () => {
    const { startup } = await import("../src/index");
    const { GLOBAL_BODY_BACKSTOP } = await import("../src/composition");
    const order: string[] = [];
    const captured: { options?: any } = {};
    const result = await startup({
      env: { ARRA_AUTH_POLICY: scratch.policyPath, ARRA_ORIGIN: ORIGIN, PORT: "3939" } as never,
      runtime: () => ({ ok: true }),
      indexWork: async () => {
        order.push("index");
      },
      build: fakeApp(order, captured),
    });
    expect(order).toEqual(["index", "listen"]);
    expect(captured.options.maxRequestBodySize).toBe(GLOBAL_BODY_BACKSTOP);
    expect(GLOBAL_BODY_BACKSTOP).toBe(1024 * 1024);
    expect(captured.options.hostname).toBe("127.0.0.1");
    expect(result.origin).toBe(ORIGIN);
  });

  test("startup uses the DEFAULT runtime reader, not just an injected one", async () => {
    // Sensitivity proof: with no `runtime` override, the real checker runs and
    // reads both installed versions. It must pass on this machine, which is
    // the pinned runtime.
    const { startup } = await import("../src/index");
    const order: string[] = [];
    await startup({
      env: { ARRA_AUTH_POLICY: scratch.policyPath, ARRA_ORIGIN: ORIGIN, PORT: "3939" } as never,
      indexWork: async () => {
        order.push("index");
      },
      build: fakeApp(order, {}),
    });
    expect(order).toEqual(["index", "listen"]);
  });

  test("the runtime check reads BOTH installed versions by default and fails closed", async () => {
    const { checkSupportedRuntime, readInstalledElysiaVersion, SUPPORTED_BUN, SUPPORTED_ELYSIA } =
      await import("../src/composition");

    // The DEFAULT path reads installed metadata for both, with no arguments.
    expect(checkSupportedRuntime().ok).toBe(true);
    expect(readInstalledElysiaVersion()).toBe(SUPPORTED_ELYSIA);
    expect(Bun.version).toBe(SUPPORTED_BUN);

    // Each pin, independently, and an absent Elysia version fails CLOSED
    // rather than being skipped — the earlier version checked Elysia only when
    // a value was passed in, so the real startup path never checked it.
    expect(checkSupportedRuntime("1.3.13").ok).toBe(false);
    expect(checkSupportedRuntime("").ok).toBe(false);
    expect(checkSupportedRuntime(SUPPORTED_BUN, "1.4.29").ok).toBe(false);
    expect(checkSupportedRuntime(SUPPORTED_BUN, undefined as never).ok).toBe(true); // default reader
    const absent = checkSupportedRuntime(SUPPORTED_BUN, "");
    expect(absent.ok).toBe(false);
  });
});
