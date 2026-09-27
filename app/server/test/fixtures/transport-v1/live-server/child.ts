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

type TokenName = "write" | "bound" | "read" | "other" | "audit";
type Step = {
  label: string;
  transport: "http" | "mcp" | "cli" | "settle";
  token: TokenName;
  bank: "alpha" | "beta";
  /** http: registry method. mcp: the TOOL name (`kb_x` or a legacy tool). */
  method: string;
  /** http: the raw request object. mcp: the tool's `arguments` object. */
  body?: unknown;
  /** cli: argv after `cli.ts`; `--bank` is added from `bank`. */
  argv?: string[];
  /** settle: milliseconds to let a fire-and-forget audit fold land. */
  ms?: number;
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
};
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
};

const opsDir = join(workDir!, "ops");
mkdirSync(opsDir, { recursive: true });
const policyPath = join(workDir!, "policy.json");
writeFileSync(
  policyPath,
  JSON.stringify({
    version: "arra-auth/v1",
    principals: Object.values(PRINCIPALS).map((p) => ({ ...p, disabled: false, global_actions: [] })),
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

async function runHttp(bank: string, token: string, method: string, body: unknown) {
  const res = await fetch(`${origin}/api/knowledge/${bank}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

async function runMcp(bank: string, token: string, tool: string, args: unknown) {
  const res = await fetch(`${origin}/mcp/${bank}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": USER_AGENT },
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

async function runCli(bank: string, token: string, argv: string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...argv, "--bank", bank], {
    env: { PATH: process.env.PATH ?? "", HOME: workDir!, ARRA_URL: origin, ARRA_TOKEN: token },
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

const outcomes: Record<string, unknown> = { tokens: TOKENS, userAgent: USER_AGENT };
try {
  for (const step of payload.steps) {
    const bank = step.bank === "alpha" ? payload.banks.alpha : payload.banks.beta;
    const token = TOKENS[step.token];
    try {
      if (step.transport === "settle") {
        await Bun.sleep(step.ms ?? 250);
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
