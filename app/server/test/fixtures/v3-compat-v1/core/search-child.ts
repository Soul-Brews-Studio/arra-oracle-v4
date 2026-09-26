// V5 (docs/overnight/V3-PARITY.md §4.4, §7 "V5"; DECISIONS.md R18 D3, R7, R14)
// gated child for `test/mcp-v3-search.test.ts`: runs INSIDE the real writer
// gate (fd 42).
//
// Boots the production pieces `buildApp` wires (composeService + createApp +
// createMcpAdapter, v3 flag on) over a fresh dataset, with ONE seam: the
// knowledge access is built by `createKnowledgeAccess` with a deterministic
// STUB query embedder instead of `composition.ts`'s Ollama client, so no test
// ever reaches a running model. A step may flip the stub to "down" (it then
// throws, which the kernel reports as `model_unavailable`, overnight R21).
//
// Steps are MCP calls through `app.handle()` with `{$ref}` captures, plus one
// helper step kind, `embed`, that writes the stub's vector for every chunk
// of a node's head revision through `kb_listSearchChunks` +
// `kb_writeChunkEmbedding` -- the backfill an embed worker would run.
//
// Principals: rw (read+write, peers [neo]) and ro (read) on bank A, other
// (read+write) on bank B, and wo (content:write ONLY) on bank A, for the
// exact-grant checks.
//
// argv: [datasetRoot, workDir, payloadJson]; stdout: one JSON object.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readArgPayload } from "../../../helpers/argv.readArgPayload";

type Who = "rw" | "ro" | "other" | "wo";
type Step = {
  label: string;
  as?: Who;
  bank: string;
  tool?: string;
  args?: unknown;
  peer?: string;
  embedderDown?: boolean;
  /** Helper step: embed every chunk of this node's head revision with the stub. */
  embed?: { node: unknown };
  capture?: { name: string; path: (string | number)[] }[];
};
const [, , datasetRoot, workDir, payloadJson] = process.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as { banks: { a: string; b: string }; steps: Step[] };
const { a: BANK_A, b: BANK_B } = payload.banks;

const DIMS = 384;
// EMBEDDING_MODEL is cleared BEFORE the kernel loads, so the one active
// profile of the #30 registry (R7, search-chunk.profiles.ts) is the stub's,
// `ollama/all-minilm/384/none`. The registry refuses any other name -- the
// bare "all-minilm" this fixture used to send predates that registry and
// matched no indexed row (the search-embed merge left it behind).
delete process.env.EMBEDDING_MODEL;
const { activeEmbeddingProfileId } = await import("../../../../src/publication/search-chunk");
const PROFILE = activeEmbeddingProfileId();
/** Deterministic trigram-hash vector, unit length: similar text, near vectors. */
function stubVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  const points = [...text.toLowerCase()];
  for (let i = 0; i + 3 <= points.length; i++) {
    let h = 2166136261;
    for (const c of points.slice(i, i + 3).join("")) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0;
    v[h % DIMS]! += 1;
  }
  const norm = Math.hypot(...v);
  if (norm === 0) v[0] = 1;
  return norm === 0 ? v : v.map((x) => x / norm);
}
let embedderDown = false;
const embedCalls: string[] = [];
const embedder = {
  profile: PROFILE,
  embed: async (text: string) => {
    embedCalls.push(text);
    if (embedderDown) throw new Error("stub embedder is down");
    return stubVector(text);
  },
};

const TOKEN: Record<Who, string> = { rw: "d4".repeat(32), ro: "e5".repeat(32), other: "f6".repeat(32), wo: "a7".repeat(32) };
const sha = (v: string) => createHash("sha256").update(v, "ascii").digest("hex");
const policyPath = join(workDir!, "policy.json");
writeFileSync(
  policyPath,
  JSON.stringify({
    version: "arra-auth/v1",
    principals: [
      { id: "rw", disabled: false, workspaces: [{ name: BANK_A, actions: ["content:read", "content:write"], peers: ["neo"] }], global_actions: [] },
      { id: "ro", disabled: false, workspaces: [{ name: BANK_A, actions: ["content:read"] }], global_actions: [] },
      { id: "other", disabled: false, workspaces: [{ name: BANK_B, actions: ["content:read", "content:write"] }], global_actions: [] },
      // Write-only on bank A: exact-grant admission never lets it read.
      { id: "wo", disabled: false, workspaces: [{ name: BANK_A, actions: ["content:write"] }], global_actions: [] },
    ],
    credentials: (Object.keys(TOKEN) as Who[]).map((who) => ({
      id: `cred-${who}`, principal_id: who, sha256: sha(TOKEN[who]),
      not_before: "2020-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", revoked: false,
    })),
  }),
  { encoding: "utf-8", mode: 0o600 },
);

const { createKnowledgeAccess } = await import("../../../../src/knowledge/transport");
// The process env carries the inherited writer gate (ARRA_WRITER_FD/ROOT);
// EMBEDDING_MODEL was cleared above, so the index profile is the stub's.
const access = createKnowledgeAccess({ datasetRoot: datasetRoot!, env: process.env, embedder });
const composition = await import("../../../../src/composition");
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

let id = 1;
async function call(who: Who, bank: string, tool: string, args: unknown, peer?: string) {
  const headers: Record<string, string> = { host: "127.0.0.1:3939", "content-type": "application/json", authorization: `Bearer ${TOKEN[who]}` };
  if (peer !== undefined) headers["x-arra-peer"] = peer;
  const res = await app.handle(new Request(`http://127.0.0.1:3939/mcp/${bank}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: tool, arguments: args } }),
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
  return { status: res.status, isError: body?.result?.isError === true, value, body: typeof text === "string" ? undefined : body };
}

async function embedNode(bank: string, nodeId: unknown) {
  const kb = (method: string, p: Record<string, unknown>) => call("rw", bank, `kb_${method}`, { payload: { workspace_name: bank, ...p } });
  const head = await kb("getAcceptedHead", { node_id: nodeId });
  const revision = (head.value as { revision?: { id?: string } } | null)?.revision?.id;
  const chunks = await kb("listSearchChunks", { revision_id: revision, chunker_version: "chunker/v1", embedding_profile: PROFILE });
  const written: unknown[] = [];
  for (const chunk of (Array.isArray(chunks.value) ? chunks.value : []) as { id: string; text: string }[]) {
    written.push(await kb("writeChunkEmbedding", { id: chunk.id, embedding: stubVector(chunk.text) }));
  }
  return { revision, chunks: Array.isArray(chunks.value) ? chunks.value.length : chunks, written };
}

const tools = async (who: Who, bank: string) => {
  const res = await app.handle(new Request(`http://127.0.0.1:3939/mcp/${bank}`, {
    method: "POST",
    headers: { host: "127.0.0.1:3939", "content-type": "application/json", authorization: `Bearer ${TOKEN[who]}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/list", params: {} }),
  }));
  const body = (await res.json()) as { result?: { tools?: { name: string; description: string }[] } };
  return body.result?.tools ?? [];
};

const outcomes: Record<string, unknown> = {
  lists: { rw: await tools("rw", BANK_A), ro: await tools("ro", BANK_A), other: await tools("other", BANK_B), wo: await tools("wo", BANK_A) },
};
for (const step of payload.steps) {
  embedderDown = step.embedderDown === true;
  const calls = embedCalls.length;
  const outcome =
    step.embed !== undefined
      ? await embedNode(step.bank, resolve(step.embed.node))
      : { ...(await call(step.as ?? "rw", step.bank, step.tool!, resolve(step.args ?? {}), step.peer)), embedCalls: 0 };
  if (step.embed === undefined) (outcome as { embedCalls: number }).embedCalls = embedCalls.length - calls;
  outcomes[step.label] = outcome;
  for (const capture of step.capture ?? []) {
    let node: unknown = (outcome as { value?: unknown }).value;
    for (const key of capture.path) node = (node as Record<string | number, unknown> | null)?.[key];
    captured[capture.name] = node;
  }
}
embedderDown = false;
console.log(JSON.stringify({ outcomes, captured }));
