/**
 * #32 slice B (overnight ruling R9, docs/overnight/DECISIONS.md): a model is
 * wired to `answerChat` in PRODUCTION composition, configured from env.
 *
 * "answerChat has never produced an answer outside a test stub" (the #32
 * reopen). The stub is still a stub here -- tests never call a real model --
 * but it sits where a real one would: a Bun.serve endpoint on 127.0.0.1 that
 * speaks Ollama's `/api/chat`, reached over the network by the SAME
 * `composeKnowledgeAccess(env)` `index.ts` uses, through the real HTTP route,
 * the real MCP adapter and the real CLI binary. Nothing in the server is
 * injected by the test except env.
 *
 * Proven:
 *   1. ARRA_CHAT_PROVIDER=ollama + ARRA_CHAT_URL => answerChat answers 200
 *      over HTTP, MCP and CLI, citing the evidence ids it used; exactly one
 *      model call per answer; the request pins gemma3:4b and 512 tokens.
 *   2. The model's prompt holds ONLY evidence the asking peer may read:
 *      never another session's secret, never another workspace's data.
 *   3. answerChat is admitted under content:read, not content:write.
 *   4. getChatSettings (content:read) reports the effective settings, and
 *      `{model: null}` when unconfigured -- never the model's address.
 *   5. Unconfigured, unreachable or failing model => 503 `model_unavailable`
 *      on every transport: never 500, never writer_unavailable, never a hang.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createOperationService } from "../src/auth/service";
import { composeKnowledgeAccess } from "../src/composition";
import type { KnowledgeAccess } from "../src/knowledge/transport";
import { configureKnowledgeAccess, createMcpAdapter } from "../src/mcp";
import { startChatModelStub, type ChatModelStub } from "./helpers/chat-model-stub";
import { createContextFixture } from "./helpers/context-fixture";
import { runGated } from "./helpers/publication-fixture";

const SEED = new URL("./fixtures/chat-v1/wiring-seed-child.ts", import.meta.url).pathname;
const CLI = new URL("../../cli.ts", import.meta.url).pathname;
const TIMEOUT_MS = 240_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const EVIDENCE_A = pad("wirea1");
const token = (label: string) => createHash("sha256").update(`chat-wiring:${label}`).digest("hex");
const TOKENS = { reader: token("reader"), betaReader: token("beta-reader"), writerOnly: token("writer-only") };

type Target = { origin: string; access: KnowledgeAccess; app: { handle: (r: Request) => Promise<Response> }; stop: () => void };
type Reply = { status: number; body: any; text: string };

let stub: ChatModelStub;
let cleanup: (() => Promise<void>) | null = null;
let policyDir: string | null = null;
let configured: Target;
let unconfigured: Target;
let unreachable: Target;

async function serve(policyPath: string, env: Record<string, string>): Promise<Target> {
  // `await`: the composition may be sync or async; either must work here.
  const access = (await composeKnowledgeAccess(env as NodeJS.ProcessEnv)) as KnowledgeAccess;
  const holder: { app: Target["app"] | null } = { app: null };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => holder.app!.handle(request) });
  const origin = `http://127.0.0.1:${server.port}`;
  const service = createOperationService({ policyPath }, { logCall: async () => {} } as never);
  holder.app = createApp({ origin }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });
  return { origin, access, app: holder.app, stop: () => server.stop(true) };
}

beforeAll(async () => {
  stub = startChatModelStub("ok");
  const fixture = await createContextFixture([ALPHA, BETA]);
  cleanup = fixture.cleanup;
  const seeded = await runGated(fixture.datasetRoot, SEED, [fixture.datasetRoot]);
  const line = seeded.stdout.trim().split("\n").pop() ?? "";
  if (seeded.code !== 0 || !line.includes('"ok":true')) {
    throw new Error(`seed child failed (${seeded.code}): ${line} ${seeded.stderr.slice(-1500)}`);
  }

  policyDir = await mkdtemp(join(tmpdir(), "arra-v4-chat-wiring-"));
  const policyPath = join(policyDir, "policy.json");
  const principal = (id: string, ws: string, actions: string[]) => ({
    id,
    disabled: false,
    workspaces: [{ name: ws, actions }],
    global_actions: [],
  });
  const credential = (id: string, secret: string) => ({
    id: `cred-${id}`,
    principal_id: id,
    sha256: createHash("sha256").update(secret, "ascii").digest("hex"),
    not_before: "2026-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked: false,
  });
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        principal("reader", ALPHA, ["content:read"]),
        principal("beta-reader", BETA, ["content:read"]),
        principal("writer-only", ALPHA, ["content:write"]),
      ],
      credentials: [
        credential("reader", TOKENS.reader),
        credential("beta-reader", TOKENS.betaReader),
        credential("writer-only", TOKENS.writerOnly),
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );

  const root = fixture.datasetRoot;
  configured = await serve(policyPath, { ARRA_KNOWLEDGE_DATASET_ROOT: root, ARRA_CHAT_PROVIDER: "ollama", ARRA_CHAT_URL: stub.url });
  unconfigured = await serve(policyPath, { ARRA_KNOWLEDGE_DATASET_ROOT: root });
  // A port that was bound and released: nothing listens there now.
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const closedUrl = `http://127.0.0.1:${closed.port}`;
  closed.stop(true);
  unreachable = await serve(policyPath, { ARRA_KNOWLEDGE_DATASET_ROOT: root, ARRA_CHAT_PROVIDER: "ollama", ARRA_CHAT_URL: closedUrl });
}, TIMEOUT_MS);

afterAll(async () => {
  configureKnowledgeAccess(null);
  for (const target of [configured, unconfigured, unreachable]) target?.stop();
  stub?.stop();
  if (policyDir !== null) await rm(policyDir, { recursive: true, force: true });
  if (cleanup !== null) await cleanup();
});

const parse = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

async function http(target: Target, secret: string, method: string, body: unknown, bank = ALPHA): Promise<Reply> {
  const res = await target.app.handle(
    new Request(`${target.origin}/api/knowledge/${bank}/${method}`, {
      method: "POST",
      headers: { host: new URL(target.origin).host, authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: parse(text), text };
}

/** The MCP knowledge access is a module singleton: point it at `target` first. */
async function mcp(target: Target, secret: string, method: string, payload: unknown, bank = ALPHA) {
  configureKnowledgeAccess(target.access);
  const res = await target.app.handle(
    new Request(`${target.origin}/mcp/${bank}`, {
      method: "POST",
      headers: { host: new URL(target.origin).host, authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `kb_${method}`, arguments: { payload } } }),
    }),
  );
  const envelope = (await res.json()) as { result?: { isError?: boolean; content?: { text: string }[] } };
  const text = envelope.result?.content?.[0]?.text ?? "";
  return { status: res.status, isError: envelope.result?.isError === true, value: parse(text), text };
}

async function cli(target: Target, secret: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ARRA_URL: target.origin, ARRA_TOKEN: secret },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err, value: parse(out) };
}

const ask = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  peer_name: "peer-a",
  session_name: "main",
  question: "When is the deploy? Cite the evidence id.",
  max_items: 10,
  ...overrides,
});

const MODEL_UNAVAILABLE = {
  version: "arra-publication-error/v1",
  code: "model_unavailable",
  path: "",
  message: "chat model unavailable",
};

const EFFECTIVE = { provider: "ollama", model: "gemma3:4b", max_output_tokens: 512, timeout_ms: 60000 };

/** Nothing the asking peer may not read, in any form. */
const expectOnlyAuthorized = (text: string) => {
  for (const forbidden of ["SECRET-A", "swordfish", "secret-session", pad("wiresecret1"), "PRIVATE-B", pad("wireb1")]) {
    expect(text.includes(forbidden), `model saw ${forbidden}`).toBe(false);
  }
};

describe("configured: a real network model call, from env, over every transport", () => {
  test("HTTP: a content:read credential gets the model's answer citing the evidence id", async () => {
    const before = stub.requests.length;
    const reply = await http(configured, TOKENS.reader, "answerChat", ask());
    expect(reply.status, reply.text).toBe(200);
    expect(reply.body.answer).toContain(`[${EVIDENCE_A}]`);
    expect(reply.body.items_used).toEqual([EVIDENCE_A]);
    // R4: the linked secret session was excluded, so the answer is partial.
    expect(reply.body.coverage).toBe("partial");
    expect(reply.body.excluded).toEqual([{ reason: "unauthorized", count: 1 }]);
    expectOnlyAuthorized(reply.text);

    expect(stub.requests.length - before).toBe(1);
    const sent = stub.requests.at(-1)!;
    expect(sent.path).toBe("/api/chat");
    expect(sent.body.model).toBe("gemma3:4b");
    expect(sent.body.stream).toBe(false);
    expect(sent.body.options.num_predict).toBe(512);
  });

  test("the prompt the model received holds the authorized evidence and nothing else", () => {
    const prompt = stub.requests.at(-1)!.text;
    expect(prompt).toContain("PRIVATE-A the deploy moved to Thursday");
    expect(prompt).toContain(EVIDENCE_A);
    expect(prompt).toContain("When is the deploy?");
    expectOnlyAuthorized(prompt);
  });

  test("MCP kb_answerChat: the same answer, one more model call", async () => {
    const before = stub.requests.length;
    const reply = await mcp(configured, TOKENS.reader, "answerChat", ask());
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.value.answer).toContain(`[${EVIDENCE_A}]`);
    expect(reply.value.items_used).toEqual([EVIDENCE_A]);
    expect(stub.requests.length - before).toBe(1);
    expectOnlyAuthorized(stub.requests.at(-1)!.text);
  });

  test("CLI chat ask and kb answerChat answer, exit 0", async () => {
    const before = stub.requests.length;
    const alias = await cli(configured, TOKENS.reader, "chat", "ask", "--bank", ALPHA, "--peer", "peer-a", "--session", "main", "--question", "When is the deploy?");
    expect(alias.code, alias.out + alias.err).toBe(0);
    expect(alias.value.items_used).toEqual([EVIDENCE_A]);
    const kb = await cli(configured, TOKENS.reader, "kb", "answerChat", "--bank", ALPHA, "--json", JSON.stringify(ask()));
    expect(kb.code, kb.out + kb.err).toBe(0);
    expect(kb.value.answer).toContain(`[${EVIDENCE_A}]`);
    expect(stub.requests.length - before).toBe(2);
  });

  test("another workspace's reader gets only that workspace's evidence", async () => {
    const reply = await http(configured, TOKENS.betaReader, "answerChat", ask({ workspace_name: BETA }), BETA);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.body.items_used).toEqual([pad("wireb1")]);
    const prompt = stub.requests.at(-1)!.text;
    expect(prompt).toContain("PRIVATE-B");
    expect(prompt.includes("PRIVATE-A")).toBe(false);
    expect(prompt.includes("SECRET-A")).toBe(false);
  });

  test("answerChat is admitted under content:read: a content:write-only credential is refused", async () => {
    const before = stub.requests.length;
    const reply = await http(configured, TOKENS.writerOnly, "answerChat", ask());
    expect(reply.status).toBe(403);
    expect(stub.requests.length).toBe(before);
  });

  test("getChatSettings reports the effective settings over HTTP, MCP and CLI, never the model address", async () => {
    const before = stub.requests.length;
    const viaHttp = await http(configured, TOKENS.reader, "getChatSettings", { workspace_name: ALPHA });
    expect(viaHttp.status, viaHttp.text).toBe(200);
    expect(viaHttp.body).toEqual(EFFECTIVE);
    expect(viaHttp.text.includes(stub.url)).toBe(false);
    const viaMcp = await mcp(configured, TOKENS.reader, "getChatSettings", { workspace_name: ALPHA });
    expect(viaMcp.isError, viaMcp.text).toBe(false);
    expect(viaMcp.value).toEqual(EFFECTIVE);
    const viaCli = await cli(configured, TOKENS.reader, "kb", "getChatSettings", "--bank", ALPHA, "--json", JSON.stringify({ workspace_name: ALPHA }));
    expect(viaCli.code, viaCli.out + viaCli.err).toBe(0);
    expect(viaCli.value).toEqual(EFFECTIVE);
    // A settings read is model-free.
    expect(stub.requests.length).toBe(before);
  });
});

describe("unconfigured, unreachable or failing: 503 model_unavailable, never 500, never writer_unavailable", () => {
  test("unconfigured over HTTP, MCP and CLI; getChatSettings says {model: null}; the model is never called", async () => {
    const before = stub.requests.length;
    const viaHttp = await http(unconfigured, TOKENS.reader, "answerChat", ask());
    expect(viaHttp.status, viaHttp.text).toBe(503);
    expect(viaHttp.body).toEqual(MODEL_UNAVAILABLE);

    const viaMcp = await mcp(unconfigured, TOKENS.reader, "answerChat", ask());
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.value).toEqual(MODEL_UNAVAILABLE);

    const viaCli = await cli(unconfigured, TOKENS.reader, "kb", "answerChat", "--bank", ALPHA, "--json", JSON.stringify(ask()));
    expect(viaCli.code).toBe(1);
    expect(viaCli.value).toEqual(MODEL_UNAVAILABLE);

    const settings = await http(unconfigured, TOKENS.reader, "getChatSettings", { workspace_name: ALPHA });
    expect(settings.status, settings.text).toBe(200);
    expect(settings.body).toEqual({ model: null });
    expect(stub.requests.length).toBe(before);
  });

  test("unreachable model URL => 503 model_unavailable", async () => {
    const viaHttp = await http(unreachable, TOKENS.reader, "answerChat", ask());
    expect(viaHttp.status, viaHttp.text).toBe(503);
    expect(viaHttp.body).toEqual(MODEL_UNAVAILABLE);
    const viaMcp = await mcp(unreachable, TOKENS.reader, "answerChat", ask());
    expect(viaMcp.value).toEqual(MODEL_UNAVAILABLE);
  });

  test("a model answering 500 => 503 model_unavailable, after exactly one attempt", async () => {
    const before = stub.requests.length;
    stub.mode = "error";
    try {
      const viaHttp = await http(configured, TOKENS.reader, "answerChat", ask());
      expect(viaHttp.status, viaHttp.text).toBe(503);
      expect(viaHttp.body).toEqual(MODEL_UNAVAILABLE);
    } finally {
      stub.mode = "ok";
    }
    expect(stub.requests.length - before).toBe(1);
  });
});
