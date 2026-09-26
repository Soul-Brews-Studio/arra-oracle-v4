// V1 (docs/overnight/V3-PARITY.md §4.3, §7 "V1") gated child for
// `test/mcp-v3-writes.test.ts`: runs INSIDE the real writer gate (fd 42).
//
// 1. Optional operator pre-ops through `openContextWriter` with the trusted
//    `taxonomyOperator: true` option (R6): the only way to stage a sealed
//    adapter vocabulary. That writer is closed before the app opens its own.
// 2. Boots the production pieces `buildApp` wires (composeService + createApp,
//    flag on for both) against the dataset, with its
//    `KnowledgeAccess` optionally wrapped so `indexRevisionChunks` throws for
//    the steps that ask for it -- the one fault V1 must absorb.
// 3. Replays scripted MCP calls through `app.handle()`, with `{$ref}` captures,
//    and prints one JSON object of raw outcomes. The parent asserts.
//
// argv: [datasetRoot, workDir, payloadJson]

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readArgPayload } from "../../../helpers/argv.readArgPayload";

type Who = "rw" | "free" | "ro";
type Step = {
  label: string;
  as?: Who;
  bank: string;
  tool: string;
  args: unknown;
  peer?: string;
  failIndex?: boolean;
  capture?: { name: string; path: (string | number)[] };
};
const [, , datasetRoot, workDir, payloadJson] = process.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  /** A scratch directory to run in, so the parent can prove nothing lands in cwd. */
  cwd?: string;
  banks: string[];
  operator?: { facade: string; method: string; request: unknown }[];
  steps: Step[];
};

if (payload.cwd !== undefined) process.chdir(payload.cwd);

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const operatorResults: unknown[] = [];
if (payload.operator !== undefined && payload.operator.length > 0) {
  const { openContextWriter } = await import(servicePath);
  const writer = await openContextWriter(datasetRoot!, {
    newRevisionId: () => "operatorrevision00000",
    clock: () => 1_758_412_800_000,
    sourceNamespace: null,
    taxonomyOperator: true,
  });
  for (const op of payload.operator) {
    try {
      const call = (writer as Record<string, Record<string, (b: Uint8Array) => Promise<unknown>>>)[op.facade]![op.method]!;
      operatorResults.push({ ok: true, value: await call(new TextEncoder().encode(JSON.stringify(op.request))) });
    } catch (error) {
      operatorResults.push({ ok: false, error: String((error as { code?: string }).code ?? error) });
    }
  }
  await writer.close();
}
// One writer owner per root per process, and a closed owner does not reopen:
// operator staging is therefore its own gated run, with no steps.
if (payload.steps.length === 0) {
  console.log(JSON.stringify({ operator: operatorResults }));
  process.exit(0);
}

const TOKEN: Record<Who, string> = { rw: "a1".repeat(32), free: "b2".repeat(32), ro: "c3".repeat(32) };
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
    ],
    credentials: (Object.keys(TOKEN) as Who[]).map((who) => ({
      id: `cred-${who}`, principal_id: who, sha256: sha(TOKEN[who]),
      not_before: "2020-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", revoked: false,
    })),
  }),
  { encoding: "utf-8", mode: 0o600 },
);

// The production composition, with one seam: a flag the steps flip to make
// indexRevisionChunks fail after the publish has already been accepted.
let failIndexNow = false;
const composition = await import("../../../../src/composition");
const realCompose = composition.composeKnowledgeAccess;
// composeKnowledgeAccess became async in the chat slice (#32); awaited here at
// the overnight merge.
const access = await realCompose();
// The facades are frozen, so the seam is a plain copy, not a Proxy.
const wrapped = {
  ...access,
  getBundle: async (action: Parameters<typeof access.getBundle>[0]) => {
    const bundle = (await access.getBundle(action)) as Record<string, any>;
    const context = bundle.context as Record<string, (b: Uint8Array) => Promise<unknown>>;
    return {
      ...bundle,
      context: {
        ...context,
        indexRevisionChunks: (bytes: Uint8Array) =>
          failIndexNow ? Promise.reject(new Error("injected index failure")) : context.indexRevisionChunks!(bytes),
      },
    } as unknown as Awaited<ReturnType<typeof access.getBundle>>;
  },
};
const { configureKnowledgeAccess, createMcpAdapter } = await import("../../../../src/mcp");
const { createApp } = await import("../../../../src/app");
const service = await composition.composeService({ policyPath, origin: "http://127.0.0.1:3939", port: 0, v3Compat: true });
configureKnowledgeAccess(wrapped);
// The flag goes to the app too, as buildApp passes it: only then is X-Arra-Peer read.
const app = createApp({ origin: "http://127.0.0.1:3939", v3Compat: true }, service, createMcpAdapter(service), { knowledge: { policyPath, access: wrapped } });

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

const outcomes: Record<string, unknown> = { operator: operatorResults };
let id = 1;
for (const step of payload.steps) {
  failIndexNow = step.failIndex === true;
  const headers: Record<string, string> = {
    host: "127.0.0.1:3939",
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN[step.as ?? "rw"]}`,
  };
  if (step.peer !== undefined) headers["x-arra-peer"] = step.peer;
  const res = await app.handle(new Request(`http://127.0.0.1:3939/mcp/${step.bank}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: step.tool, arguments: resolve(step.args) } }),
  }));
  const raw = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  const text = body?.result?.content?.[0]?.text;
  let value: unknown = text;
  try {
    value = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    value = text;
  }
  outcomes[step.label] = { status: res.status, isError: body?.result?.isError === true, value, body: typeof text === "string" ? undefined : body };
  if (step.capture !== undefined) {
    let node: unknown = value;
    for (const key of step.capture.path) node = (node as Record<string | number, unknown> | null)?.[key];
    captured[step.capture.name] = node;
  }
}
failIndexNow = false;
console.log(JSON.stringify(outcomes));
