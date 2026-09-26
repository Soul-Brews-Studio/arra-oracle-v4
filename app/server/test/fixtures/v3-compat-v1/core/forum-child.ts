// V4 + V10 (docs/overnight/V3-PARITY.md §4 forum tools, §7 "V4"/"V10") gated
// child for `test/mcp-v3-forum.test.ts`: runs INSIDE the real writer gate.
//
// Boots the production pieces `buildApp` wires (composeService +
// composeKnowledgeAccess + createApp, v3 flag on) against a fresh dataset and
// replays scripted MCP calls through `app.handle()`, with `{$ref}` captures.
// No seam at all: every call crosses the real auth service, the real peer
// binding and the real kernels. Prints one JSON object of raw outcomes; the
// parent asserts.
//
// Principals (every grant covers every bank in the payload):
//   rw     content:read+write, peers binding ["neo"]
//   free   content:read+write, no binding (any asserted peer)
//   ro     content:read only
//   audit  content:read + audit:read (the operator view), no binding
//
// argv: [datasetRoot, workDir, payloadJson]

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

type Who = "rw" | "free" | "ro" | "audit";
type Step = {
  label: string;
  as?: Who;
  bank: string;
  tool: string;
  args: unknown;
  peer?: string;
  capture?: { name: string; path: (string | number)[] };
};
const [, , datasetRoot, workDir, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson ?? "{}") as { banks: string[]; steps: Step[] };
void datasetRoot;

const TOKEN: Record<Who, string> = { rw: "a1".repeat(32), free: "b2".repeat(32), ro: "c3".repeat(32), audit: "d4".repeat(32) };
const sha = (v: string) => createHash("sha256").update(v, "ascii").digest("hex");
const policyPath = join(workDir!, "policy.json");
const grant = (actions: string[], peers?: string[]) =>
  payload.banks.map((name) => ({ name, actions, ...(peers === undefined ? {} : { peers }) }));
writeFileSync(
  policyPath,
  JSON.stringify({
    version: "arra-auth/v1",
    principals: [
      { id: "rw", disabled: false, workspaces: grant(["content:read", "content:write"], ["neo"]), global_actions: [] },
      { id: "free", disabled: false, workspaces: grant(["content:read", "content:write"]), global_actions: [] },
      { id: "ro", disabled: false, workspaces: grant(["content:read"]), global_actions: [] },
      { id: "audit", disabled: false, workspaces: grant(["content:read", "audit:read"]), global_actions: [] },
    ],
    credentials: (Object.keys(TOKEN) as Who[]).map((who) => ({
      id: `cred-${who}`, principal_id: who, sha256: sha(TOKEN[who]),
      not_before: "2020-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", revoked: false,
    })),
  }),
  { encoding: "utf-8", mode: 0o600 },
);

const composition = await import("../../../../src/composition");
const access = await composition.composeKnowledgeAccess();
const { configureKnowledgeAccess, createMcpAdapter } = await import("../../../../src/mcp");
const { createApp } = await import("../../../../src/app");
const service = await composition.composeService({ policyPath, origin: "http://127.0.0.1:3939", port: 0, v3Compat: true });
configureKnowledgeAccess(access);
const app = createApp({ origin: "http://127.0.0.1:3939", v3Compat: true }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });

const captured: Record<string, unknown> = {};
const resolve = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(resolve);
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.$ref === "string" && Object.keys(o).length === 1) return captured[o.$ref];
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolve(v)]));
  }
  return value;
};

const outcomes: Record<string, unknown> = {};
let id = 1;
for (const step of payload.steps) {
  const headers: Record<string, string> = {
    host: "127.0.0.1:3939",
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN[step.as ?? "rw"]}`,
  };
  if (step.peer !== undefined) headers["x-arra-peer"] = step.peer;
  const method = step.tool === "tools/list" ? "tools/list" : "tools/call";
  const params = method === "tools/list" ? {} : { name: step.tool, arguments: resolve(step.args) };
  const res = await app.handle(new Request(`http://127.0.0.1:3939/mcp/${step.bank}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  }));
  const raw = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  const text = body?.result?.content?.[0]?.text;
  let value: unknown = method === "tools/list" ? (body?.result?.tools ?? []).map((t: { name: string }) => t.name) : text;
  try {
    value = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    // plain text stays text
  }
  outcomes[step.label] = { status: res.status, isError: body?.result?.isError === true, value, body: typeof text === "string" || method === "tools/list" ? undefined : body };
  if (step.capture !== undefined) {
    let node: unknown = value;
    for (const key of step.capture.path) node = (node as Record<string | number, unknown> | null)?.[key];
    captured[step.capture.name] = node;
  }
}
console.log(JSON.stringify(outcomes));
