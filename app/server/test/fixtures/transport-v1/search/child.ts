// #30 retrieval (overnight R7 #30 part + R14): real-dataset, real-gate child
// for `search-chunk-retrieval-live.test.ts`.
//
// Same shape as `../expose13/child.ts`: runs INSIDE the real writer gate,
// boots the REAL HTTP app and the REAL MCP adapter over ONE
// `createKnowledgeAccess`, then replays the parent's steps at the wire and
// prints one JSON object of outcomes. The one addition is the query embedder
// the knowledge access is composed with -- a deterministic stub keyed by query
// text, standing in for `composition.ts`'s Ollama embedder. No model, no
// network.
//
// A step may `capture` a value from its own response under a name; a later
// step's body references it as the exact string "@name". A `tools_list` step
// asks MCP `tools/list` with that step's token and records the tool names.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../../../src/app";
import { createKnowledgeAccess } from "../../../../src/knowledge/transport";
import { createOperationService, type OperationService, type StoreDependencies } from "../../../../src/auth/service";
import { createMcpAdapter, configureKnowledgeAccess } from "../../../../src/mcp";

const [, , root, workDir, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  banks: { alpha: string; beta: string };
  embedderProfile: string;
  queryVectors: Record<string, number[]>;
  steps: Array<{
    label: string;
    transport: "http" | "mcp" | "tools_list";
    token: "write" | "read" | "other";
    bank: "alpha" | "beta";
    method?: string;
    body?: unknown;
    capture?: { name: string; path: (string | number)[] };
  }>;
};

const captured: Record<string, unknown> = {};
function substitute(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("@") && value.slice(1) in captured) return captured[value.slice(1)];
  if (Array.isArray(value)) return value.map(substitute);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v)]));
  }
  return value;
}
function readPath(obj: unknown, path: (string | number)[]): unknown {
  let node = obj;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

const ORIGIN = "http://127.0.0.1:3939";
const sha = (v: string) => createHash("sha256").update(v, "ascii").digest("hex");
const TOKEN_OF = { write: "1".repeat(64), read: "2".repeat(64), other: "3".repeat(64) } as const;

function writePolicy(): string {
  const policyPath = join(workDir!, "policy.json");
  const credential = (id: string, principal: string, token: string) => ({
    id,
    principal_id: principal,
    sha256: sha(token),
    not_before: "2020-01-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked: false,
  });
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        { id: "alpha-write", disabled: false, workspaces: [{ name: payload.banks.alpha, actions: ["content:read", "content:write"] }], global_actions: [] },
        { id: "alpha-read", disabled: false, workspaces: [{ name: payload.banks.alpha, actions: ["content:read"] }], global_actions: [] },
        { id: "beta-write", disabled: false, workspaces: [{ name: payload.banks.beta, actions: ["content:read", "content:write"] }], global_actions: [] },
      ],
      credentials: [
        credential("cred-write", "alpha-write", TOKEN_OF.write),
        credential("cred-read", "alpha-read", TOKEN_OF.read),
        credential("cred-other", "beta-write", TOKEN_OF.other),
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
  return policyPath;
}

const policyPath = writePolicy();
const embedCalls: string[] = [];
const access = createKnowledgeAccess({
  datasetRoot: root,
  env: process.env,
  embedder: {
    profile: payload.embedderProfile,
    embed: async (text: string) => {
      embedCalls.push(text);
      const vector = payload.queryVectors[text];
      if (vector === undefined) throw new Error("stub embedder: no vector for this query");
      return vector;
    },
  },
} as Parameters<typeof createKnowledgeAccess>[0]);

const httpService = {} as unknown as OperationService;
const unusedMcpHandle = (() => {
  throw new Error("unused: /mcp/:bank is not exercised, the MCP adapter is called directly");
}) as unknown as ReturnType<typeof createMcpAdapter>;
const app = createApp({ origin: ORIGIN }, httpService, unusedMcpHandle, { knowledge: { policyPath, access } });
const mcpService = createOperationService({ policyPath }, { logCall: async () => {} } as unknown as StoreDependencies);
configureKnowledgeAccess(access);
const mcpAdapter = createMcpAdapter(mcpService);

async function runHttp(bank: string, token: string, method: string, body: unknown) {
  const res = await app.handle(
    new Request(`${ORIGIN}/api/knowledge/${bank}/${method}`, {
      method: "POST",
      headers: { host: "127.0.0.1:3939", authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function runMcp(bank: string, token: string, rpc: Record<string, unknown>) {
  const outcome = await mcpAdapter(bank, `Bearer ${token}`, async () => ({ id: 1, ...rpc }));
  if (outcome.kind === "denied") return { denied: outcome.code };
  return (await outcome.response.json()) as { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] } };
}

const outcomes: Record<string, unknown> = {};
for (const step of payload.steps) {
  const bank = step.bank === "alpha" ? payload.banks.alpha : payload.banks.beta;
  const token = TOKEN_OF[step.token];
  let outcome: unknown;
  try {
    if (step.transport === "http") {
      outcome = await runHttp(bank, token, step.method!, substitute(step.body));
    } else if (step.transport === "tools_list") {
      const listed = await runMcp(bank, token, { method: "tools/list" });
      outcome = "denied" in listed ? listed : { tools: (listed.result?.tools ?? []).map((tool) => tool.name) };
    } else {
      const called = await runMcp(bank, token, {
        method: "tools/call",
        params: { name: `kb_${step.method}`, arguments: { payload: substitute(step.body) } },
      });
      if ("denied" in called) outcome = called;
      else if (called.result?.isError === true) outcome = { isError: true, message: called.result.content?.[0]?.text ?? null };
      else outcome = { ok: true, value: JSON.parse(called.result?.content?.[0]?.text ?? "null") };
    }
  } catch (error) {
    outcome = { threw: error instanceof Error ? error.message : String(error) };
  }
  outcomes[step.label] = outcome;
  if (step.capture !== undefined) {
    const valueRoot = step.transport === "http" ? (outcome as { body?: unknown }).body : (outcome as { value?: unknown }).value;
    captured[step.capture.name] = readPath(valueRoot, step.capture.path);
  }
}
outcomes.embedCalls = embedCalls;

console.log(JSON.stringify(outcomes));
