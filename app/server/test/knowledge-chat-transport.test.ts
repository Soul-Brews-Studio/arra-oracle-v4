// #33 knowledge-explorer UI: proves the two registry entries this task added
// (`getContext`, `answerChat`) actually round-trip through the REAL
// `createApp` transport (routing, body-encoding checks, workspace-scope
// admission via a real policy file) end to end, the same way
// `transport-service.test.ts` proves `getVocabulary` does. Only the LanceDB
// storage read is faked (the reader/writer bundle), for the same reason that
// file fakes it: standing up a full target-19 dataset is out of scope here.
//
// This is what "the Chat view calls a real endpoint, not a mock" means in
// this codebase: the fake is at the facade seam publication/service.ts
// already defines, not at the HTTP boundary the UI actually talks to.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { KnowledgeAccess } from "../src/knowledge/transport";
import type { KnowledgeBundle } from "../src/knowledge/registry";
import { parseAnswerChat, parseGetContext } from "../src/publication/chat";
import type { OperationService } from "../src/auth/service";
import type { createMcpAdapter } from "../src/mcp";

const ORIGIN = "http://127.0.0.1:3939";
const url = (path: string) => `${ORIGIN}${path}`;

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN_SHA256 = createHash("sha256").update(TOKEN, "ascii").digest("hex");

const policyDocument = () => ({
  version: "arra-auth/v1",
  principals: [
    {
      id: "acme-op",
      disabled: false,
      workspaces: [{ name: "acme", actions: ["content:read", "content:write"] }],
      global_actions: [],
    },
  ],
  credentials: [
    {
      id: "cred-acme",
      principal_id: "acme-op",
      sha256: TOKEN_SHA256,
      not_before: "2026-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z",
      revoked: false,
    },
  ],
});

let policyPath: string;
let dataDir: string;
let app: { handle: (request: Request) => Promise<Response> };

const CONTEXT_ITEM = {
  public_id: "aaaaaaaaaaaaaaaaaaaaa",
  session_name: "s1",
  peer_name: "nat",
  role: "user",
  content: "hello from a real fake row",
  seq_in_session: "1",
  created_at: "2026-09-21T00:00:00.000Z",
};

/** Real governed request parsers (`parseGetContext`/`parseAnswerChat`), faked
 *  retrieval and faked model -- exactly the `getVocabulary` smoke-test shape. */
const fakeBundle: KnowledgeBundle = {
  // `registry.ts`'s `isWriterBundle` distinguishes a writer bundle by probing
  // `publication.publishRevision` -- unrelated to chat, but the SAME writer
  // bundle carries both facades, so this probe must be present for
  // `answerChat` to be recognized as writer-side at all.
  publication: { publishRevision: (async () => { throw new Error("unused in this test"); }) as never } as never,
  taxonomy: {} as never,
  context: {
    async getContext(bytes: Uint8Array) {
      const request = parseGetContext(bytes); // REAL governed parser
      expect(request.workspace_name).toBe("acme");
      return { items: [CONTEXT_ITEM], coverage: "full" as const, excluded: [] };
    },
    async answerChat(bytes: Uint8Array) {
      const request = parseAnswerChat(bytes); // REAL governed parser
      return {
        answer: `stub answer to: ${request.question}`,
        coverage: "full",
        excluded: [],
        items_used: [CONTEXT_ITEM.public_id],
      };
    },
  } as never,
  evidence: {} as never,
};

const access: KnowledgeAccess = { getBundle: async () => fakeBundle };

const request = (path: string, init: RequestInit = {}) =>
  new Request(url(path), { ...init, headers: { host: "127.0.0.1:3939", ...(init.headers ?? {}) } });

const send = (path: string, init?: RequestInit) => app.handle(request(path, init));

const authedJson = (bodyBytes: Uint8Array | string): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: bodyBytes as BodyInit,
});

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "arra-v4-knowledge-chat-transport-"));
  policyPath = join(dataDir, "policy.json");
  await writeFile(policyPath, JSON.stringify(policyDocument()), { encoding: "utf-8", mode: 0o600 });

  const service = {} as unknown as OperationService;
  const mcpHandle = (() => {
    throw new Error("unused in this smoke test");
  }) as unknown as ReturnType<typeof createMcpAdapter>;

  app = createApp({ origin: ORIGIN }, service, mcpHandle, { knowledge: { policyPath, access } });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("knowledge explorer: getContext round-trips (read-only)", () => {
  test("a valid request returns the real facade's items, coverage and exclusions", async () => {
    const body = JSON.stringify({ workspace_name: "acme", peer_name: "nat", session_name: "s1", max_items: 10 });
    const res = await send("/api/knowledge/acme/getContext", authedJson(body));
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed).toEqual({ items: [CONTEXT_ITEM], coverage: "full", excluded: [] });
  });

  test("a body naming a different workspace than the route is refused before the facade ever runs", async () => {
    const body = JSON.stringify({ workspace_name: "someone-else", peer_name: "nat", session_name: "s1", max_items: 10 });
    const res = await send("/api/knowledge/acme/getContext", authedJson(body));
    expect(res.status).toBe(400);
  });

  test("no bearer token is unauthenticated", async () => {
    const body = JSON.stringify({ workspace_name: "acme", peer_name: "nat", session_name: "s1", max_items: 10 });
    const res = await send("/api/knowledge/acme/getContext", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
  });
});

describe("knowledge explorer: answerChat requires the writer action", () => {
  test("a valid request round-trips the stub model's answer", async () => {
    const body = JSON.stringify({
      workspace_name: "acme",
      peer_name: "nat",
      session_name: "s1",
      question: "what happened in this session?",
      max_items: 10,
    });
    const res = await send("/api/knowledge/acme/answerChat", authedJson(body));
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.answer).toBe("stub answer to: what happened in this session?");
    expect(parsed.items_used).toEqual([CONTEXT_ITEM.public_id]);
  });

  test("a caller with only content:read on the workspace is refused before the facade runs", async () => {
    const readOnlyPolicyPath = join(dataDir, "read-only-policy.json");
    await writeFile(
      readOnlyPolicyPath,
      JSON.stringify({
        ...policyDocument(),
        principals: [
          {
            id: "acme-op",
            disabled: false,
            workspaces: [{ name: "acme", actions: ["content:read"] }],
            global_actions: [],
          },
        ],
      }),
      { encoding: "utf-8", mode: 0o600 },
    );
    const readOnlyApp = createApp({ origin: ORIGIN }, {} as unknown as OperationService, (() => {
      throw new Error("unused");
    }) as unknown as ReturnType<typeof createMcpAdapter>, {
      knowledge: { policyPath: readOnlyPolicyPath, access },
    });
    const body = JSON.stringify({
      workspace_name: "acme",
      peer_name: "nat",
      session_name: "s1",
      question: "should be refused",
      max_items: 10,
    });
    const res = await readOnlyApp.handle(request("/api/knowledge/acme/answerChat", authedJson(body)));
    expect(res.status).toBe(403);
  });
});
