// Shared setup for `./inner.ts` and the test files it registers
// (`./service-level.ts`, `./live-transports.ts`, `./audit-poisoning.ts`).
//
// Split out of `inner.ts` in the #103 fix round (2026-09-26): that file had
// grown to 520 lines, past the 500-line cap. The scenarios stay in ONE
// `bun test` process -- they share one `ARRA_DATA_DIR`, which `storage.ts`
// freezes at first import -- so this is a function the process calls ONCE,
// from `inner.ts`'s `beforeAll`, never a module with import-time effects.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Connection } from "@lancedb/lancedb";
import { Field, Int64, Schema, TimestampMicrosecond, Utf8 } from "apache-arrow";
import { callSchema, memorySchema, TOKENS } from "../../helpers/auth-fixture";
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

type McpCallsOverrides = Partial<{ after_id: string | null; limit: number; tool: string | null; status: string | null; include_total: boolean }>;
type ConnectionsOverrides = Partial<{ after_id: string | null; limit: number; include_total: boolean }>;

export type OperationsRootFixture = {
  opsRoot: string;
  opsConnection: Connection;
  knowledge: Fixture;
  calls: typeof import("../../../src/mcp/calls");
  connections: typeof import("../../../src/mcp/connections");
  opsListMcpCalls: typeof import("../../../src/mcp/calls.listMcpCalls").listMcpCalls;
  opsListConnections: typeof import("../../../src/mcp/connections.listConnections").listConnections;
  app: { handle(request: Request): Promise<Response> };
  mcpHandle: ReturnType<typeof import("../../../src/mcp").createMcpAdapter>;
  mcpCallsRequest(workspace: string, overrides?: McpCallsOverrides): Uint8Array;
  connectionsRequest(workspace: string, overrides?: ConnectionsOverrides): Uint8Array;
  cleanup(): Promise<void>;
};

/**
 * Principals, by what each test file needs:
 *   person-a       audit:read on livealpha + livebeta; generates the traffic
 *                  `live-transports.ts` counts (cred-a)
 *   person-ro      content:read ONLY on livealpha (cred-ro) -- the caller the
 *                  #103 fix-round verifier used to poison the audit listing
 *   person-lister  audit:read on both; OBSERVES the audit trail (cred-lister)
 *                  so listing -- itself an audited call -- never inflates the
 *                  counts person-a's tests assert on
 */
export async function openOperationsRootFixture(): Promise<OperationsRootFixture> {
  // Env FIRST, before any import touches `storage.ts` -- this process has
  // never imported it before, so this is the ONLY value `DATA_DIR` ever takes.
  const opsRoot = await mkdtemp(join(tmpdir(), "arra-v4-ops-root-"));
  process.env.ARRA_DATA_DIR = opsRoot;

  // A GENUINELY DIFFERENT physical dataset, matching `app/just/dev-stack.sh`'s
  // split-root deployment -- proves the readers no longer depend on this
  // root at all, and that its OWN `mcp_calls`/`connections` copies stay
  // empty (R5: they live in `ARRA_DATA_DIR` until #34).
  const knowledge = await createFixture(["livealpha", "livebeta"]);
  process.env.ARRA_KNOWLEDGE_DATASET_ROOT = knowledge.datasetRoot;

  const opsConnection = await connect(opsRoot);
  await opsConnection.createEmptyTable("mcp_calls", callSchema);
  await opsConnection.createEmptyTable("connections", connectionSchema);
  // `list_memories` needs a real (empty) legacy table to SUCCEED, so the
  // poisoning tests can prove the success path is normalized too, not only
  // the validation-error path.
  await opsConnection.createEmptyTable("memories", memorySchema);

  const policyPath = join(opsRoot, "policy.json");
  process.env.ARRA_AUTH_POLICY = policyPath;
  const credential = (id: string, principal_id: string, sha256: string) => ({
    id,
    principal_id,
    sha256,
    not_before: "2026-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked: false,
  });
  const auditBoth = [
    { name: "livealpha", actions: ["audit:read"] },
    { name: "livebeta", actions: ["audit:read"] },
  ];
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        { id: "person-a", disabled: false, workspaces: auditBoth, global_actions: [] },
        { id: "person-ro", disabled: false, workspaces: [{ name: "livealpha", actions: ["content:read"] }], global_actions: [] },
        { id: "person-lister", disabled: false, workspaces: auditBoth, global_actions: [] },
      ],
      credentials: [
        credential("cred-a", "person-a", TOKENS.alpha.sha256),
        credential("cred-ro", "person-ro", TOKENS.beta.sha256),
        credential("cred-lister", "person-lister", TOKENS.maint.sha256),
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );

  const calls = await import("../../../src/mcp/calls");
  const connections = await import("../../../src/mcp/connections");
  const opsListMcpCalls = (await import("../../../src/mcp/calls.listMcpCalls")).listMcpCalls;
  const opsListConnections = (await import("../../../src/mcp/connections.listConnections")).listConnections;
  const { buildApp } = await import("../../../src/index");
  const { createMcpAdapter } = await import("../../../src/mcp");
  const { composeService } = await import("../../../src/composition");

  const built = await buildApp({ policyPath, origin: ORIGIN });
  const app = {
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
  const mcpHandle = createMcpAdapter(await composeService({ policyPath, origin: ORIGIN, port: 0 }));

  return {
    opsRoot,
    opsConnection,
    knowledge,
    calls,
    connections,
    opsListMcpCalls,
    opsListConnections,
    app,
    mcpHandle,
    mcpCallsRequest: (workspace, overrides = {}) =>
      bytesFor({ workspace_name: workspace, after_id: null, limit: 50, tool: null, status: null, include_total: true, ...overrides }),
    connectionsRequest: (workspace, overrides = {}) =>
      bytesFor({ workspace_name: workspace, after_id: null, limit: 50, include_total: true, ...overrides }),
    async cleanup() {
      await knowledge.cleanup();
      await rm(opsRoot, { recursive: true, force: true });
    },
  };
}
