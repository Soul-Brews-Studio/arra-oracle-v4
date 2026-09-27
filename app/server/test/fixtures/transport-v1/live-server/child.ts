// #31 audit parity and #75 read-cursor replay (acceptance-criteria live
// slice, 2026-09-26): a REAL listening server on a fresh dataset, driven over
// the wire by HTTP, MCP and the real CLI process.
//
// Runs INSIDE the real writer gate (`runGated`, fd 42). Unlike
// `../expose13/child.ts`, which calls `app.handle` and the MCP adapter
// in-process, this child boots the production `buildApp` (`src/index.ts`:
// `composeService` + `composeKnowledgeAccess`, the same composition
// `startup()` uses) and LISTENS on 127.0.0.1, so every step below is a real
// TCP request -- and the CLI step is a real `bun app/cli.ts` process talking
// to that port. The operations root (`ARRA_DATA_DIR`, where `mcp_calls` and
// `connections` live per R5) is a fresh directory under the caller's mktemp
// work dir; the knowledge root is the caller's gated fixture dataset. No
// model is reachable: `OLLAMA_URL` points at a closed port, and every R2/S3
// variable is scrubbed so storage can only resolve to local paths.
//
// It prints one JSON object keyed by step label; the parent test owns every
// assertion.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readArgPayload } from "../../../helpers/argv.readArgPayload";

/** `diag` and `maint` (#31 legacy-audit slice) are additive: nothing else sends them. */
type TokenName = "write" | "bound" | "read" | "other" | "audit" | "diag" | "maint";
/** Never admitted: `none` sends no Authorization header, `bogus` a token no credential hashes to. */
type Unadmitted = "none" | "bogus";
type Step = {
  label: string;
  /** legacy: a legacy HTTP memory route (`path`, `httpMethod`, raw `body`), #31 legacy-audit slice.
   *  tables: every row of both operations tables, read directly, in EVERY workspace (#31 maint-audit). */
  transport: "http" | "mcp" | "cli" | "settle" | "legacy" | "tables";
  token: TokenName | Unadmitted;
  bank: "alpha" | "beta";
  /** http: registry method. mcp: the TOOL name (`kb_x` or a legacy tool). */
  method: string;
  /** http: the raw request object. mcp: the tool's `arguments` object. */
  body?: unknown;
  /** cli: argv after `cli.ts`; `--bank` is added from `bank`. */
  argv?: string[];
  /** settle: the deadline, in ms, for the fire-and-forget folds to land. */
  ms?: number;
  /** settle: how many folded requests the `connections` table must count. */
  folds?: number;
  /** legacy: the route path with its query, `{alpha}`/`{beta}` replaced by the bank. */
  path?: string;
  /** legacy: GET or POST. */
  httpMethod?: "GET" | "POST";
};

const [, , root, workDir, payloadJson] = process.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  banks: { alpha: string; beta: string };
  steps: Step[];
};

const sha = (v: string) => createHash("sha256").update(v, "ascii").digest("hex");
const TOKENS: Record<TokenName, string> = {
  write: "4".repeat(64),
  bound: "5".repeat(64),
  read: "6".repeat(64),
  other: "7".repeat(64),
  audit: "8".repeat(64),
  diag: "3".repeat(64),
  maint: "2".repeat(64),
};
const UNADMITTED: Record<Unadmitted, string | null> = { none: null, bogus: "9".repeat(64) };
const USER_AGENT = "arra-live-parity-test";

const grant = (name: string, actions: string[], peers?: string[]) =>
  peers === undefined ? { name, actions } : { name, actions, peers };
const PRINCIPALS: Record<TokenName, { id: string; workspaces: unknown[] }> = {
  write: { id: "alpha-write", workspaces: [grant(payload.banks.alpha, ["content:read", "content:write"])] },
  // #87 / R3 binding: this credential may speak only as peer-a.
  bound: { id: "alpha-bound", workspaces: [grant(payload.banks.alpha, ["content:read", "content:write"], ["peer-a"])] },
  read: { id: "alpha-read", workspaces: [grant(payload.banks.alpha, ["content:read"])] },
  other: { id: "beta-write", workspaces: [grant(payload.banks.beta, ["content:read", "content:write"])] },
  audit: { id: "alpha-audit", workspaces: [grant(payload.banks.alpha, ["content:read", "audit:read"])] },
  diag: { id: "alpha-diag", workspaces: [grant(payload.banks.alpha, ["diagnostics:read"])] },
  maint: { id: "ops-maint", workspaces: [] },
};
/** Global grants: only `maint` holds any (the legacy maintenance routes). */
const GLOBAL_ACTIONS: Partial<Record<TokenName, string[]>> = { maint: ["maintenance:backfill", "maintenance:reindex"] };

const opsDir = join(workDir!, "ops");
mkdirSync(opsDir, { recursive: true });
const policyPath = join(workDir!, "policy.json");
writeFileSync(
  policyPath,
  JSON.stringify({
    version: "arra-auth/v1",
    principals: (Object.keys(PRINCIPALS) as TokenName[]).map((name) => ({
      ...PRINCIPALS[name],
      disabled: false,
      global_actions: GLOBAL_ACTIONS[name] ?? [],
    })),
    credentials: (Object.keys(TOKENS) as TokenName[]).map((name) => ({
      id: `cred-${name}`,
      principal_id: PRINCIPALS[name].id,
      sha256: sha(TOKENS[name]),
      not_before: "2020-01-01T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
      revoked: false,
    })),
  }),
  { encoding: "utf-8", mode: 0o600 },
);

// Environment BEFORE any server module loads: `storage.ts` reads
// ARRA_DATA_DIR at import, `embed.ts` reads OLLAMA_URL at import.
for (const key of ["R2_ACCOUNT_ID", "S3_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "ARRA_CHAT_URL", "ARRA_CHAT_MODEL"]) {
  delete process.env[key];
}
process.env.ARRA_DATA_DIR = opsDir;
process.env.ARRA_KNOWLEDGE_DATASET_ROOT = root!;
process.env.ARRA_AUTH_POLICY = policyPath;
process.env.OLLAMA_URL = "http://127.0.0.1:9";
process.env.ARRA_MCP_V3_COMPAT = "0";

// The operations root's tables are created by the operator path (dev-stack /
// the legacy exporter), never by the server; create them empty, with the
// same schemas `../../operations-root-v1/fixture.ts` uses.
{
  const { connect } = await import("@lancedb/lancedb");
  const { callSchema, memorySchema } = await import("../../../helpers/auth-fixture");
  const { connectionSchema } = await import("../../operations-root-v1/fixture");
  const ops = await connect(opsDir);
  await ops.createEmptyTable("mcp_calls", callSchema);
  await ops.createEmptyTable("connections", connectionSchema);
  await ops.createEmptyTable("memories", memorySchema);
}

// A free loopback port, so the Host/Origin gate sees the origin it was built for.
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null) });
const port = probe.port;
probe.stop(true);
const origin = `http://127.0.0.1:${port}`;

const { buildApp } = await import("../../../../src/index");
const app = await buildApp({ policyPath, origin, v3Compat: false });
app.listen({ port, hostname: "127.0.0.1" });

const CLI = join(import.meta.dir, "..", "..", "..", "..", "..", "cli.ts");

const bearer = (token: string | null): Record<string, string> => (token === null ? {} : { authorization: `Bearer ${token}` });

async function runHttp(bank: string, token: string | null, method: string, body: unknown) {
  const res = await fetch(`${origin}/api/knowledge/${bank}/${method}`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

/** A legacy HTTP memory route, raw: the body is sent exactly as given (a string stays a string). */
async function runLegacy(token: string | null, httpMethod: "GET" | "POST", path: string, body: unknown) {
  const res = await fetch(`${origin}${path}`, {
    method: httpMethod,
    headers: {
      ...bearer(token),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "user-agent": USER_AGENT,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

async function runMcp(bank: string, token: string | null, tool: string, args: unknown) {
  const res = await fetch(`${origin}/mcp/${bank}`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args ?? {} } }),
  });
  if (res.status !== 200) return { status: res.status, denied: await res.text() };
  const parsed = (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean } };
  const result = parsed.result;
  if (result === undefined) return { status: 200, malformed: parsed };
  const text = result.content?.[0]?.text ?? "null";
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {}
  return { status: 200, isError: result.isError === true, value };
}

async function runCli(bank: string, token: string | null, argv: string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...argv, "--bank", bank], {
    env: { PATH: process.env.PATH ?? "", HOME: workDir!, ARRA_URL: origin, ...(token === null ? {} : { ARRA_TOKEN: token }) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let value: unknown = stdout.trim();
  try {
    value = JSON.parse(stdout);
  } catch {}
  return { exit, value, stderr: stderr.slice(0, 2000) };
}

/**
 * Wait for the connection folds, which `composition.ts` fires without await,
 * by reading the operations table DIRECTLY rather than over the wire: every
 * admitted wire read is itself audited and folded, so polling over HTTP or
 * MCP would move the count it is waiting on. Returns the settled count.
 */
async function settleFolds(folds: number, deadlineMs: number) {
  const { connect } = await import("@lancedb/lancedb");
  const deadline = Date.now() + deadlineMs;
  let requests = 0;
  for (;;) {
    // Reopened each round: an open table handle keeps reading its version.
    const table = await (await connect(opsDir)).openTable("connections");
    const rows = await table.query().toArray();
    requests = rows.reduce((n, row) => n + Number(row.requests), 0);
    if (requests >= folds || Date.now() > deadline) return { requests };
    await Bun.sleep(25);
  }
}

/**
 * #31 maint-audit: both operations tables, read DIRECTLY and unscoped. Every
 * wire reader is scoped to one admitted workspace, so a row filed under any
 * other name (a sentinel for a global action, say) is invisible over the wire;
 * this is the only view that can prove no such row exists.
 */
async function readOperationsTables() {
  const { connect } = await import("@lancedb/lancedb");
  const db = await connect(opsDir);
  const rows = async (name: string) => {
    const all = await (await db.openTable(name)).query().toArray();
    return all.map((row) => ({ workspace_name: row.workspace_name, tool: row.tool ?? row.last_tool ?? null, status: row.status ?? null }));
  };
  // #31 maint-audit D4b: instance_audit is a SEPARATE table this same
  // unscoped connection can read; it does not exist until the first
  // maintenance call writes it, so an absent table reads as no rows rather
  // than an error.
  const names = await db.tableNames();
  const instanceAudit = names.includes("instance_audit")
    ? (await (await db.openTable("instance_audit")).query().toArray()).map((row) => ({
        route: row.route,
        action: row.action,
        outcome: row.outcome,
        status: row.status,
        principal_id: row.principal_id,
        input_summary: row.input_summary,
      }))
    : [];
  return { mcp_calls: await rows("mcp_calls"), connections: await rows("connections"), instance_audit: instanceAudit };
}

const outcomes: Record<string, unknown> = { tokens: { ...TOKENS, bogus: UNADMITTED.bogus }, userAgent: USER_AGENT };
try {
  for (const step of payload.steps) {
    const bank = step.bank === "alpha" ? payload.banks.alpha : payload.banks.beta;
    const token = step.token === "none" || step.token === "bogus" ? UNADMITTED[step.token] : TOKENS[step.token];
    try {
      if (step.transport === "settle") {
        outcomes[step.label] = await settleFolds(step.folds ?? 0, step.ms ?? 250);
        continue;
      }
      if (step.transport === "tables") {
        outcomes[step.label] = await readOperationsTables();
        continue;
      }
      if (step.transport === "legacy") {
        const path = (step.path ?? "").replaceAll("{alpha}", payload.banks.alpha).replaceAll("{beta}", payload.banks.beta);
        outcomes[step.label] = await runLegacy(token, step.httpMethod ?? "GET", path, step.body);
        continue;
      }
      outcomes[step.label] =
        step.transport === "http"
          ? await runHttp(bank, token, step.method, step.body)
          : step.transport === "mcp"
            ? await runMcp(bank, token, step.method, step.body)
            : await runCli(bank, token, step.argv ?? []);
    } catch (error) {
      outcomes[step.label] = { threw: error instanceof Error ? error.message : String(error) };
    }
  }
} finally {
  app.stop?.(true);
}

console.log(JSON.stringify(outcomes));
process.exit(0);
