// The v3-compat acceptance session, run INSIDE the real writer gate (fd 42).
//
// `test/mcp-v3-acceptance.test.ts` launches this through `runGated` /
// `exec_with_gate`, the same way every other live transport test does
// (`fixtures/transport-v1/expose13/child.ts`). Before this child existed the
// harness built the app in the plain `bun test` process, where no writer gate
// is held, so every content:write failed with `writer_unavailable` and no
// write step could ever go green.
//
// It boots the REAL production composition, `buildApp` from `src/index.ts`
// (composeService + composeKnowledgeAccess + configureKnowledgeAccess +
// createApp + createMcpAdapter), and drives every step through
// `app.handle()` -> the real `POST /mcp/:bank` route. It records raw wire
// observations only; the parent decides PASS / FAIL / GAP.
//
// argv: [datasetRoot, workDir]
// env (set by the parent): ARRA_DATA_DIR, ARRA_KNOWLEDGE_DATASET_ROOT,
//   ARRA_MCP_V3_COMPAT. The policy file is written here, mode 0600.
// stdout: one JSON line {lists, steps, captured}.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession, type As, type Step } from "../../../helpers/v3-compat-shapes";

const [, , , workDir] = process.argv;
const session = loadSession();

const HOST = "127.0.0.1:3939";
const ORIGIN = `http://${HOST}`;
const TOKEN: Record<As, string> = { rw: "4".repeat(64), ro: "5".repeat(64), other: "6".repeat(64) };
const sha = (v: string) => createHash("sha256").update(v, "ascii").digest("hex");

const policyPath = join(workDir!, "policy.json");
writeFileSync(
  policyPath,
  JSON.stringify({
    version: "arra-auth/v1",
    principals: (Object.keys(TOKEN) as As[]).map((who) => {
      const p = session.principals[who];
      const grant: Record<string, unknown> = { name: p.workspace, actions: p.actions };
      if (p.peers !== undefined) grant.peers = p.peers;
      return { id: who, disabled: false, workspaces: [grant], global_actions: [] };
    }),
    credentials: (Object.keys(TOKEN) as As[]).map((who) => ({
      id: `cred-${who}`,
      principal_id: who,
      sha256: sha(TOKEN[who]),
      not_before: "2020-01-01T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
      revoked: false,
    })),
  }),
  { encoding: "utf-8", mode: 0o600 },
);

const { buildApp } = await import("../../../../src/index");
const app = await buildApp({ policyPath, origin: ORIGIN });

type Wire = { status: number; json: unknown };
let rpcId = 1;

async function rpc(as: As, body: Record<string, unknown>, extra: Record<string, string> = {}): Promise<Wire> {
  const response = await app.handle(
    new Request(`${ORIGIN}/mcp/${session.principals[as].workspace}`, {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json", authorization: `Bearer ${TOKEN[as]}`, ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, ...body }),
    }),
  );
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

const names = (wire: Wire): string[] => {
  const tools = (wire.json as { result?: { tools?: { name?: unknown }[] } })?.result?.tools;
  return Array.isArray(tools) ? tools.map((t) => t.name).filter((n): n is string => typeof n === "string") : [];
};

/** A tool result's first text block, parsed when it is JSON. */
const valueOf = (wire: Wire): unknown => {
  const text = (wire.json as { result?: { content?: { text?: unknown }[] } })?.result?.content?.[0]?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const captured: Record<string, unknown> = {};

/** `{$ref: name}` -> the captured value; an unresolved ref stays visible. */
function resolve(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolve);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$ref === "string" && Object.keys(obj).length === 1) {
      return obj.$ref in captured ? captured[obj.$ref] : `__unresolved_ref__:${obj.$ref}`;
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolve(v)]));
  }
  return value;
}

// What each principal is advertised, once, before any step: GAP is judged
// against this, and it cannot change mid-session (the flag and the registry
// are fixed for the process).
const lists: Record<string, { status: number; names: string[] }> = {};
for (const who of Object.keys(TOKEN) as As[]) {
  const wire = await rpc(who, { method: "tools/list", params: {} });
  lists[who] = { status: wire.status, names: names(wire) };
}

type Outcome = { args?: unknown; list?: { status: number; names: string[] }; call?: Wire; unknown?: Wire; spawnCalls?: number };
const steps: Record<number, Outcome> = {};

for (const step of session.steps as Step[]) {
  const outcome: Outcome = {};
  steps[step.step] = outcome;
  if (step.method === "tools/list") {
    const wire = await rpc(step.as, { method: "tools/list", params: {} });
    outcome.list = { status: wire.status, names: names(wire) };
    continue;
  }
  const args = resolve(step.arguments ?? {});
  outcome.args = args;
  const headers: Record<string, string> = step.peer ? { "x-arra-peer": step.peer } : {};

  const spawnCalls: unknown[] = [];
  const originalSpawn = Bun.spawn;
  const originalSpawnSync = Bun.spawnSync;
  if (step.assert.assertNoSpawn) {
    (Bun as { spawn: unknown }).spawn = (...a: unknown[]) => {
      spawnCalls.push(a);
      throw new Error("spy: Bun.spawn must not run for a not-carried tool");
    };
    (Bun as { spawnSync: unknown }).spawnSync = (...a: unknown[]) => {
      spawnCalls.push(a);
      throw new Error("spy: Bun.spawnSync must not run for a not-carried tool");
    };
  }
  try {
    outcome.call = await rpc(step.as, { method: "tools/call", params: { name: step.tool, arguments: args } }, headers);
    if (step.assert.compareToUnknownTool) {
      outcome.unknown = await rpc(step.as, {
        method: "tools/call",
        params: { name: step.assert.compareToUnknownTool, arguments: {} },
      });
    }
  } finally {
    (Bun as { spawn: unknown }).spawn = originalSpawn;
    (Bun as { spawnSync: unknown }).spawnSync = originalSpawnSync;
  }
  if (step.assert.assertNoSpawn) outcome.spawnCalls = spawnCalls.length;

  const isError = (outcome.call.json as { result?: { isError?: unknown } })?.result?.isError === true;
  if (step.capture && outcome.call.status === 200 && !isError) {
    const value = valueOf(outcome.call) as Record<string, unknown> | undefined;
    if (value !== undefined && value !== null && typeof value === "object") captured[step.capture.as] = value[step.capture.path];
  }
}

console.log(JSON.stringify({ lists, steps, captured }));
