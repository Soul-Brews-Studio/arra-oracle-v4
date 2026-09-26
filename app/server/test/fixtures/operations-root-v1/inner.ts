// #103 / #102, DECISIONS.md R5: `mcp_calls` and `connections` are operations
// tables written straight to `ARRA_DATA_DIR` (`mcp/calls.ts`,
// `mcp/connections.ts`). This file proves the READERS (`mcp/calls.listMcpCalls.ts`,
// `mcp/connections.listConnections.ts`, wired in `knowledge/registry.ts`) now
// answer from that same root, on BOTH transports, with workspace isolation,
// pagination and `audit:read` authorization unchanged -- and that the #102
// fold no longer corrupts `connections` under concurrent writers.
//
// ISOLATION (fix-round finding, 2026-09-26): this file is named `inner.ts`,
// not `*.test.ts`, so Bun's own test-discovery glob (`.test.`/`.spec.` in the
// filename) never picks it up when a directory is handed to `bun test`
// (`test:full`'s `bun test test ../cli.test.ts`) or when `test.order.ts`
// walks `test/` for `*.test.ts` (`bun run test`, `test:parallel`). The ONLY
// way to run it is the explicit path invocation the sibling
// `../../operations-root-readers.test.ts` performs via `runOwnedChild`, which
// gives THIS file's own process -- and therefore its own, never-before-
// touched copy of `storage.ts` -- to set `ARRA_DATA_DIR` on. `DATA_DIR` is a
// `const` read from `process.env.ARRA_DATA_DIR` at module load
// (`storage.ts:15`), so sharing a `bun test` process with ANY file that
// already imported `../src/app` (statically or otherwise) before this file's
// `beforeAll` runs would freeze `DATA_DIR` to whatever THAT file set (or the
// default `../data`) -- measured regression: `bun test
// test/transport-service.test.ts test/mcp-correctness.test.ts` went from
// 31 pass / 0 fail to 16 pass / 15 fail once `knowledge/registry.ts` gained a
// STATIC import of this table's reader (fixed by making that import lazy;
// see `registry.ts`'s own comment). A dedicated process removes the sharing
// risk entirely rather than relying on file ordering.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Connection } from "@lancedb/lancedb";
import { Field, Int64, Schema, TimestampMicrosecond, Utf8 } from "apache-arrow";
import { bearer, callRow, callSchema, TOKENS } from "../../helpers/auth-fixture";
import { createFixture, type Fixture } from "../../helpers/publication-fixture";

const utf8 = (name: string, nullable = true) => new Field(name, new Utf8(), nullable);
const int64 = (name: string, nullable = false) => new Field(name, new Int64(), nullable);

/** Mirrors `TARGET_SCHEMA.connections` in `publication/storage.ts` exactly --
 *  the legacy and target19 `connections` shapes are identical (12 columns,
 *  same types), unlike `mcp_calls` (10 vs 12). */
const connectionSchema = new Schema([
  utf8("id", false),
  utf8("workspace_name", false),
  utf8("method", false),
  utf8("principal", false),
  utf8("label", false),
  utf8("user_agent"),
  utf8("remote_ip"),
  new Field("first_seen", new TimestampMicrosecond(), false),
  new Field("last_seen", new TimestampMicrosecond(), false),
  int64("requests"),
  int64("tool_calls"),
  utf8("last_tool"),
]);

const HOST = "127.0.0.1:3939";
const ORIGIN = `http://${HOST}`;
const bytesFor = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const mcpCallsRequest = (
  workspace: string,
  overrides: Partial<{ after_id: string | null; limit: number; tool: string | null; status: string | null; include_total: boolean }> = {},
) => bytesFor({ workspace_name: workspace, after_id: null, limit: 50, tool: null, status: null, include_total: true, ...overrides });
const connectionsRequest = (
  workspace: string,
  overrides: Partial<{ after_id: string | null; limit: number; include_total: boolean }> = {},
) => bytesFor({ workspace_name: workspace, after_id: null, limit: 50, include_total: true, ...overrides });

/**
 * `foldConnection` runs fire-and-forget from `composition.ts`'s `logCall`
 * wrapper (`void connections.foldConnection(...).catch(() => {})`) -- the
 * MCP response returns as soon as `calls.logCall` (the AWAITED half)
 * resolves, with no guarantee the fold's own read-modify-write has finished.
 * That is existing, unchanged production behaviour, so the test polls the
 * reader directly rather than assuming a single synchronous write. Unlike
 * before the #102 fix-round concurrency fix, this poll no longer needs to
 * treat `integrity_failure` as "keep polling" -- overlapping folds for the
 * same id are now queued (`connections.ts`'s `foldQueues`), so the page
 * either has not caught up yet (empty/short) or is already correct; a real
 * `integrity_failure` here would be a genuine regression and must fail the
 * test, not be swallowed.
 */
async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 3000, intervalMs = 20): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for the connection fold to settle");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

let opsRoot: string;
let opsConnection: Connection;
let knowledge: Fixture;
let policyPath: string;

let calls: typeof import("../../../src/mcp/calls");
let connections: typeof import("../../../src/mcp/connections");
let opsListMcpCalls: typeof import("../../../src/mcp/calls.listMcpCalls").listMcpCalls;
let opsListConnections: typeof import("../../../src/mcp/connections.listConnections").listConnections;
let buildApp: typeof import("../../../src/index").buildApp;
let createMcpAdapter: typeof import("../../../src/mcp").createMcpAdapter;
let composeService: typeof import("../../../src/composition").composeService;
let app: { handle(request: Request): Promise<Response> };
let mcpHandle: ReturnType<typeof createMcpAdapter>;

beforeAll(async () => {
  // Env FIRST, before any import touches `storage.ts` -- this file's own
  // process has never imported it before, so this is the ONLY write that
  // will ever happen to `DATA_DIR` (see the file header).
  opsRoot = await mkdtemp(join(tmpdir(), "arra-v4-ops-root-"));
  process.env.ARRA_DATA_DIR = opsRoot;

  // A GENUINELY DIFFERENT physical dataset, matching `app/just/dev-stack.sh`'s
  // split-root deployment -- proves the readers no longer depend on this
  // root at all, and that its OWN `mcp_calls`/`connections` copies stay
  // empty (R5: they live in `ARRA_DATA_DIR` until #34).
  knowledge = await createFixture(["livealpha", "livebeta"]);
  process.env.ARRA_KNOWLEDGE_DATASET_ROOT = knowledge.datasetRoot;

  opsConnection = await connect(opsRoot);
  await opsConnection.createEmptyTable("mcp_calls", callSchema);
  await opsConnection.createEmptyTable("connections", connectionSchema);

  policyPath = join(opsRoot, "policy.json");
  process.env.ARRA_AUTH_POLICY = policyPath;
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        {
          id: "person-a",
          disabled: false,
          workspaces: [
            { name: "livealpha", actions: ["audit:read"] },
            { name: "livebeta", actions: ["audit:read"] },
          ],
          global_actions: [],
        },
        {
          id: "person-ro",
          disabled: false,
          workspaces: [{ name: "livealpha", actions: ["content:read"] }],
          global_actions: [],
        },
        {
          // A SEPARATE principal for observing the audit trail, so that
          // `kb_listMcpCalls`/`kb_listConnections` themselves -- which are
          // ALSO audited `tools/call` invocations -- do not inflate the very
          // counts the "person-a" tests below assert on.
          id: "person-lister",
          disabled: false,
          workspaces: [
            { name: "livealpha", actions: ["audit:read"] },
            { name: "livebeta", actions: ["audit:read"] },
          ],
          global_actions: [],
        },
      ],
      credentials: [
        {
          id: "cred-a",
          principal_id: "person-a",
          sha256: TOKENS.alpha.sha256,
          not_before: "2026-01-01T00:00:00.000Z",
          expires_at: "2030-01-01T00:00:00.000Z",
          revoked: false,
        },
        {
          id: "cred-ro",
          principal_id: "person-ro",
          sha256: TOKENS.beta.sha256,
          not_before: "2026-01-01T00:00:00.000Z",
          expires_at: "2030-01-01T00:00:00.000Z",
          revoked: false,
        },
        {
          id: "cred-lister",
          principal_id: "person-lister",
          sha256: TOKENS.maint.sha256,
          not_before: "2026-01-01T00:00:00.000Z",
          expires_at: "2030-01-01T00:00:00.000Z",
          revoked: false,
        },
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );

  calls = await import("../../../src/mcp/calls");
  connections = await import("../../../src/mcp/connections");
  opsListMcpCalls = (await import("../../../src/mcp/calls.listMcpCalls")).listMcpCalls;
  opsListConnections = (await import("../../../src/mcp/connections.listConnections")).listConnections;
  ({ buildApp } = await import("../../../src/index"));
  ({ createMcpAdapter } = await import("../../../src/mcp"));
  ({ composeService } = await import("../../../src/composition"));

  const built = await buildApp({ policyPath, origin: ORIGIN });
  app = {
    handle(request: Request) {
      const headers = new Headers(request.headers);
      headers.set("host", HOST);
      const url = new URL(request.url);
      const rebased = new URL(url.pathname + url.search, ORIGIN);
      return built.handle(
        new Request(rebased, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          // @ts-expect-error duplex is required when streaming a body in Bun
          duplex: "half",
        }),
      );
    },
  };
  mcpHandle = createMcpAdapter(await composeService({ policyPath, origin: ORIGIN, port: 0 }));
}, 30_000);

afterAll(async () => {
  await knowledge?.cleanup();
  if (opsRoot !== undefined) await rm(opsRoot, { recursive: true, force: true });
}, 30_000);

describe("service level: listMcpCalls reads the operations root directly", () => {
  test("pagination, filters and total all scope to one workspace", async () => {
    const table = await opsConnection.openTable("mcp_calls");
    await table.add([
      callRow("c1", "svc-alpha", 100, { status: "ok", tool: "recall" }),
      callRow("c2", "svc-alpha", 200, { status: "error", tool: "remember" }),
      callRow("c3", "svc-alpha", 300, { status: "ok", tool: "recall" }),
      callRow("cx", "svc-beta", 400, { status: "ok", tool: "recall" }),
    ]);

    const page1 = await opsListMcpCalls(mcpCallsRequest("svc-alpha", { limit: 2 }));
    expect(page1.rows.map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(page1.total).toBe("3");
    expect(page1.next_after_id).toBe("c2");
    expect(page1.rows.every((r) => r.workspace_name === "svc-alpha")).toBe(true);
    expect(typeof page1.rows[0]!.duration_ms).toBe("string");
    expect(typeof page1.rows[0]!.created_at).toBe("string");
    // Legacy `mcp_calls` has no `connection_id`/`principal` columns -- the
    // encoder must turn their absence into null, not throw.
    expect(page1.rows[0]).toMatchObject({ connection_id: null, principal: null });

    const page2 = await opsListMcpCalls(mcpCallsRequest("svc-alpha", { after_id: "c2", limit: 2 }));
    expect(page2.rows.map((r) => r.id)).toEqual(["c3"]);
    expect(page2.next_after_id).toBeNull();

    const errorsOnly = await opsListMcpCalls(mcpCallsRequest("svc-alpha", { status: "error" }));
    expect(errorsOnly.rows.map((r) => r.id)).toEqual(["c2"]);
    expect(errorsOnly.total).toBe("1");

    const betaOnly = await opsListMcpCalls(mcpCallsRequest("svc-beta"));
    expect(betaOnly.rows.map((r) => r.id)).toEqual(["cx"]);
    expect(betaOnly.total).toBe("1");
    // Isolation: svc-alpha's page never contains svc-beta's row.
    expect(page1.rows.some((r) => r.id === "cx")).toBe(false);
  });
});

describe("service level: listConnections reads the operations root directly", () => {
  test("folds one row per (workspace, method, principal, label), truncates the label, isolates by workspace", async () => {
    await connections.foldConnection({ workspace_name: "svc-alpha", method: "mcp", principal: "cred-x", label: "client/1.0", tool: "recall" });
    await connections.foldConnection({ workspace_name: "svc-alpha", method: "mcp", principal: "cred-x", label: "client/1.0", tool: "recall" });
    await connections.foldConnection({ workspace_name: "svc-alpha", method: "mcp", principal: "cred-x", label: "client/1.0", tool: null });
    await connections.foldConnection({ workspace_name: "svc-alpha", method: "mcp", principal: "cred-y", label: "other/2.0", tool: "remember" });
    await connections.foldConnection({ workspace_name: "svc-beta", method: "mcp", principal: "cred-x", label: "client/1.0", tool: "recall" });
    const longLabel = "L".repeat(2500);
    await connections.foldConnection({ workspace_name: "svc-alpha", method: "mcp", principal: "cred-trunc", label: longLabel, tool: "recall" });

    const alpha = await opsListConnections(connectionsRequest("svc-alpha"));
    expect(alpha.total).toBe("3");
    expect(alpha.rows.every((r) => r.workspace_name === "svc-alpha")).toBe(true);

    const credX = alpha.rows.find((r) => r.principal === "cred-x");
    expect(credX).toMatchObject({ workspace_name: "svc-alpha", method: "mcp", label: "client/1.0", requests: "3", tool_calls: "2" });
    const firstSeen = Date.parse(credX!.first_seen as string);
    const lastSeen = Date.parse(credX!.last_seen as string);
    expect(Number.isNaN(firstSeen)).toBe(false);
    expect(Number.isNaN(lastSeen)).toBe(false);
    expect(firstSeen).toBeLessThanOrEqual(lastSeen);

    const truncated = alpha.rows.find((r) => r.principal === "cred-trunc");
    expect(truncated!.label).toBe(`${longLabel.slice(0, 2000)}…[2500 chars]`);

    // Isolation: svc-beta's own row for the SAME principal/label is a
    // DIFFERENT id and never appears in svc-alpha's page.
    const beta = await opsListConnections(connectionsRequest("svc-beta"));
    expect(beta.total).toBe("1");
    expect(beta.rows.every((r) => r.workspace_name === "svc-beta")).toBe(true);
    expect(alpha.rows.some((r) => r.id === beta.rows[0]!.id)).toBe(false);
  });

  /**
   * #102 fix-round blocking finding (verifier, 2026-09-26): `foldConnection`
   * launched fire-and-forget for the SAME id, with no in-process
   * serialization, wrote several rows sharing one id -- measured, before the
   * fix, `Promise.all` of 5 concurrent folds gave 5 rows, all id-equal,
   * `requests` all `1` (every fold read "no prior row"). `listConnections`'s
   * own duplicate-id integrity check then correctly refused the WHOLE page
   * with `integrity_failure` -- a page that used to always be empty (nothing
   * read this root before R5) and now failed outright on ordinary traffic.
   */
  test("concurrent folds for the SAME id never create duplicate rows or an unreadable page", async () => {
    const event = { workspace_name: "svc-concurrent", method: "mcp", principal: "cred-race", label: "racer/1.0", tool: "recall" };
    await Promise.all(Array.from({ length: 8 }, () => connections.foldConnection(event)));

    const raw = (await (await opsConnection.openTable("connections"))
      .query()
      .where(`workspace_name = 'svc-concurrent'`)
      .toArray()) as Record<string, unknown>[];
    expect(raw.length).toBe(1);

    const page = await opsListConnections(connectionsRequest("svc-concurrent"));
    expect(page.total).toBe("1");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ workspace_name: "svc-concurrent", principal: "cred-race", requests: "8", tool_calls: "8" });
  });
});

describe("live HTTP + MCP, distinct data roots (R5)", () => {
  test("the target19 knowledge root's own copies stay empty (#34 not migrated yet)", async () => {
    const knowledgeConnection = await connect(knowledge.datasetRoot);
    const knowledgeCalls = await (await knowledgeConnection.openTable("mcp_calls")).countRows();
    const knowledgeConns = await (await knowledgeConnection.openTable("connections")).countRows();
    expect(knowledgeCalls).toBe(0);
    expect(knowledgeConns).toBe(0);
  });

  /** One real, admitted, audited `tools/call`. */
  const rpc = async (bank: string, token: string, args: Record<string, unknown>, ua = "test-client/1.0") => {
    const outcome = await mcpHandle(bank, bearer(token), async () => ({ method: "tools/call", id: 1, params: { name: "call_log", arguments: args } }), ua);
    if (outcome.kind !== "response") throw new Error(`unexpected outcome ${outcome.kind}`);
    return outcome.response.json() as Promise<any>;
  };

  /**
   * Poll the operations root DIRECTLY (never through MCP -- listing over MCP
   * is itself an audited call and would perturb the very state being
   * awaited) until `principal`'s folded row shows exactly `expectedRequests`.
   * A genuine `integrity_failure` here is now a hard test failure (see the
   * file-level comment on `waitFor`), not something to poll past.
   */
  const settledConnectionsRow = (bank: string, principal: string, expectedRequests: number) =>
    waitFor(async () => {
      const page = await opsListConnections(connectionsRequest(bank));
      const row = page.rows.find((r) => r.principal === principal);
      return row !== undefined && row.requests === String(expectedRequests) ? row : null;
    });

  test("a live success AND a live failure each appear exactly once in listMcpCalls, never in the other workspace's list", async () => {
    // Two admitted, audited calls on livealpha: one succeeds, one fails
    // validation inside `dispatchTool` -- both still reach `appendAudit`.
    const ok = await rpc("livealpha", TOKENS.alpha.secret, { limit: 5 });
    expect(ok.result?.isError).toBeUndefined();
    const failed = await rpc("livealpha", TOKENS.alpha.secret, { status: "bogus" });
    expect(failed.result?.isError).toBe(true);
    await settledConnectionsRow("livealpha", "cred-a", 2);
    // One admitted call on livebeta, so its list is exactly one row.
    await rpc("livebeta", TOKENS.alpha.secret, { limit: 5 });
    await settledConnectionsRow("livebeta", "cred-a", 1);

    // Listed by a DIFFERENT credential (`cred-lister`): `kb_listMcpCalls` is
    // itself an audited `tools/call` for `tool: "call_log"`'s cousin, so
    // listing as `cred-a` would add its own row on every observation.
    // Filtering `tool: "call_log"` excludes it either way; using a separate
    // credential also keeps this test from folding a THIRD connections
    // event onto `cred-a`'s already-checked row.
    const list = async (bank: string) => {
      const outcome = await mcpHandle(
        bank,
        bearer(TOKENS.maint.secret),
        async () => ({
          method: "tools/call",
          id: 1,
          params: { name: "kb_listMcpCalls", arguments: { payload: { workspace_name: bank, after_id: null, limit: 50, tool: "call_log", status: null, include_total: true } } },
        }),
        "",
      );
      if (outcome.kind !== "response") throw new Error(`unexpected outcome ${outcome.kind}`);
      const body = await outcome.response.json();
      return JSON.parse(body.result.content[0].text);
    };

    const alphaOverMcp = await list("livealpha");
    expect(alphaOverMcp.total).toBe("2");
    expect(alphaOverMcp.rows.map((r: any) => r.status).sort()).toEqual(["error", "ok"]);
    expect(alphaOverMcp.rows.every((r: any) => r.workspace_name === "livealpha")).toBe(true);

    const httpRes = await app.handle(
      new Request("http://localhost/api/knowledge/livealpha/listMcpCalls", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: bearer(TOKENS.maint.secret) },
        body: JSON.stringify({ workspace_name: "livealpha", after_id: null, limit: 50, tool: "call_log", status: null, include_total: true }),
      }),
    );
    expect(httpRes.status).toBe(200);
    const httpBody = await httpRes.json();
    expect(httpBody.total).toBe("2");
    expect(httpBody.rows.map((r: any) => r.status).sort()).toEqual(["error", "ok"]);

    const betaOverMcp = await list("livebeta");
    expect(betaOverMcp.total).toBe("1");
    expect(betaOverMcp.rows.every((r: any) => r.workspace_name === "livebeta")).toBe(true);
    // Isolation: livebeta's row id never appears on livealpha's page.
    const betaIds = new Set(betaOverMcp.rows.map((r: any) => r.id));
    expect(alphaOverMcp.rows.some((r: any) => betaIds.has(r.id))).toBe(false);
  });

  test("listConnections folds livealpha's two calls into one row keyed by credential_id, distinct from livebeta's, over MCP and HTTP", async () => {
    // The previous test already drove these to the expected counts and
    // waited for them to settle; re-confirm rather than re-wait, so a
    // regression here fails fast instead of hanging on `waitFor`'s timeout.
    const alphaDirect = await opsListConnections(connectionsRequest("livealpha"));
    const credA = alphaDirect.rows.find((r) => r.principal === "cred-a");
    expect(credA?.requests).toBe("2");

    const listOverMcp = async (bank: string) => {
      const outcome = await mcpHandle(
        bank,
        bearer(TOKENS.maint.secret),
        async () => ({
          method: "tools/call",
          id: 1,
          params: { name: "kb_listConnections", arguments: { payload: { workspace_name: bank, after_id: null, limit: 50, include_total: true } } },
        }),
        "",
      );
      if (outcome.kind !== "response") throw new Error(`unexpected outcome ${outcome.kind}`);
      const body = await outcome.response.json();
      return JSON.parse(body.result.content[0].text);
    };

    const alpha = await listOverMcp("livealpha");
    const row = alpha.rows.find((r: any) => r.principal === "cred-a");
    expect(row).toBeDefined();
    expect(row.workspace_name).toBe("livealpha");
    // DECISIONS.md R5: `principal` is the CREDENTIAL id ("cred-a"), never
    // the principal id ("person-a") the credential belongs to.
    expect(row.principal).toBe("cred-a");
    expect(row.principal).not.toBe("person-a");
    expect(row.label).toBe("test-client/1.0");
    expect(row.requests).toBe("2");
    expect(row.tool_calls).toBe("2");
    expect(row.remote_ip).toBeNull();
    expect(Number.isNaN(Date.parse(row.first_seen as string))).toBe(false);
    expect(Number.isNaN(Date.parse(row.last_seen as string))).toBe(false);

    const beta = await listOverMcp("livebeta");
    const betaRow = beta.rows.find((r: any) => r.principal === "cred-a");
    expect(betaRow).toBeDefined();
    expect(betaRow.workspace_name).toBe("livebeta");
    expect(betaRow.id).not.toBe(row.id);

    // Coverage gap the fix-round flagged: HTTP `listConnections` was never
    // exercised, only MCP. Same admitted caller, same expected row, over the
    // OTHER transport.
    const httpRes = await app.handle(
      new Request("http://localhost/api/knowledge/livealpha/listConnections", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: bearer(TOKENS.maint.secret) },
        body: JSON.stringify({ workspace_name: "livealpha", after_id: null, limit: 50, include_total: true }),
      }),
    );
    expect(httpRes.status).toBe(200);
    const httpBody = await httpRes.json();
    const httpRow = httpBody.rows.find((r: any) => r.principal === "cred-a");
    expect(httpRow).toMatchObject({ workspace_name: "livealpha", principal: "cred-a", requests: "2", tool_calls: "2" });
  });

  /**
   * The exact scenario the #102 fix-round verifier measured live: several
   * MCP `tools/call` requests from ONE client, back-to-back, with NO
   * settle-wait between them (unlike the test above, which deliberately
   * waits so the fold never overlaps). Before the concurrency fix this
   * produced duplicate-id rows and `listConnections` answered 500
   * `integrity_failure` for the WHOLE workspace on every poll.
   */
  test("back-to-back MCP calls from one client, with no settle-wait between them, never break listConnections for the workspace", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await rpc("livealpha", TOKENS.alpha.secret, { limit: 5 + i });
      expect(result.result?.isError).toBeUndefined();
      // Deliberately NOT awaiting the fold to settle here -- the whole point
      // is to fire the next admitted request while the previous one's
      // background fold may still be in flight.
    }

    const row = await settledConnectionsRow("livealpha", "cred-a", 2 + 5); // 2 from the earlier test + 5 here
    expect(row.requests).toBe("7");

    const raw = (await (await opsConnection.openTable("connections"))
      .query()
      .where(`workspace_name = 'livealpha' AND principal = 'cred-a'`)
      .toArray()) as Record<string, unknown>[];
    expect(raw).toHaveLength(1);
  });

  test("a caller without audit:read is denied on both transports, unchanged", async () => {
    const outcome = await mcpHandle(
      "livealpha",
      bearer(TOKENS.beta.secret),
      async () => ({ method: "tools/call", id: 1, params: { name: "kb_listMcpCalls", arguments: { payload: { workspace_name: "livealpha", after_id: null, limit: 50, tool: null, status: null, include_total: true } } } }),
      "",
    );
    expect(outcome.kind).toBe("denied");
    expect(outcome.kind === "denied" && outcome.code).toBe("forbidden");

    const httpRes = await app.handle(
      new Request("http://localhost/api/knowledge/livealpha/listMcpCalls", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: bearer(TOKENS.beta.secret) },
        body: JSON.stringify({ workspace_name: "livealpha", after_id: null, limit: 50, tool: null, status: null, include_total: true }),
      }),
    );
    expect(httpRes.status).toBe(403);
  });
});
