// #32 slice A (overnight ruling R9, docs/overnight/DECISIONS.md): `answerChat`
// never opens a writer at all.
//
// HISTORY: `answerChat` used to live on the writer facade, only because the
// injected model travelled in writer options. #33 then routed it through an
// "ephemeral" per-request writer so it would not pin the cached one -- but in
// a real gated process that ephemeral writer contended for the one `OWNERS`
// slot (chat after any write answered `writer_unavailable`) and its close
// released the process's only inherited fd-42 gate (every write after the
// first chat answered `writer_unavailable`). `chat-gate-coexistence.test.ts`
// proves both against the real gate.
//
// THE FIX THIS FILE PINS at the routing seam: `answerChat` is a READ. The
// model is composed onto the READER bundle's `chat` facade, the method is
// admitted under `content:read`, and the transport asks `getBundle` for the
// reader -- the same path every other read takes. There is no ephemeral
// writer left to open. This is a spy `KnowledgeAccess`, not a dataset: it
// asserts WHICH bundle the transport asks for; the real-gate proof lives in
// the coexistence test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.createApp";
import { createKnowledgeAccess, type KnowledgeAccess } from "../src/knowledge/transport";
import { KNOWLEDGE_METHODS, type KnowledgeBundle } from "../src/knowledge/registry";
import { parseAnswerChat } from "../src/publication/chat";
import { parseJoinSession } from "../src/publication/context";
import type { OperationService } from "../src/auth/service.createOperationService";
import type { createMcpAdapter } from "../src/mcp";

const ORIGIN = "http://127.0.0.1:3939";
const url = (path: string) => `${ORIGIN}${path}`;
const WORKSPACE = "acme";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN_SHA256 = createHash("sha256").update(TOKEN, "ascii").digest("hex");

const policyDocument = () => ({
  version: "arra-auth/v1",
  principals: [
    {
      id: "op",
      disabled: false,
      workspaces: [{ name: WORKSPACE, actions: ["content:read", "content:write"] }],
      global_actions: [],
    },
  ],
  credentials: [
    {
      id: "cred",
      principal_id: "op",
      sha256: TOKEN_SHA256,
      not_before: "2026-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z",
      revoked: false,
    },
  ],
});

const request = (path: string, init: RequestInit = {}) =>
  new Request(url(path), { ...init, headers: { host: "127.0.0.1:3939", ...(init.headers ?? {}) } });

const authedJson = (body: string): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body,
});

let policyPath: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "arra-v4-chat-gate-"));
  policyPath = join(dataDir, "policy.json");
  await writeFile(policyPath, JSON.stringify(policyDocument()), { encoding: "utf-8", mode: 0o600 });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** A reader bundle with the `chat` facade `createKnowledgeAccess` composes. */
function fakeReaderBundle(chatCalls: string[]) {
  return {
    publication: {} as never,
    taxonomy: {} as never,
    context: {} as never,
    evidence: {} as never,
    chat: {
      async answerChat(bytes: Uint8Array) {
        parseAnswerChat(bytes); // real governed parser, same discipline as elsewhere
        chatCalls.push("answerChat");
        return { answer: "stub", coverage: "full", excluded: [], excluded_omitted: 0, items_used: [] };
      },
      async getChatSettings() {
        chatCalls.push("getChatSettings");
        return { model: null };
      },
    },
  };
}

/** A writer bundle whose `close` is instrumented; `publication.publishRevision`
 *  is the probe `registry.ts`'s `isWriterBundle` keys on. */
function fakeWriterBundle(closeCalls: number[]) {
  return {
    publication: { publishRevision: (async () => { throw new Error("unused"); }) as never } as never,
    taxonomy: {} as never,
    context: {
      async joinSession(bytes: Uint8Array) {
        parseJoinSession(bytes); // real governed parser
        return null;
      },
    } as never,
    evidence: {} as never,
    close: async () => {
      closeCalls.push(1);
    },
  };
}

const mcpHandleStub = (() => {
  throw new Error("unused in this test");
}) as unknown as ReturnType<typeof createMcpAdapter>;

const askBody = JSON.stringify({
  workspace_name: WORKSPACE,
  peer_name: "nat",
  session_name: "s1",
  question: "does this open a writer?",
  max_items: 5,
});

describe("answerChat is a read: it takes the reader bundle and never opens a writer", () => {
  test("answerChat asks getBundle for content:read only, and runs on the reader's chat facade", async () => {
    const getBundleCalls: string[] = [];
    const chatCalls: string[] = [];
    const closeCalls: number[] = [];
    const access: KnowledgeAccess = {
      getBundle: async (action) => {
        getBundleCalls.push(action);
        return (action === "content:write" ? fakeWriterBundle(closeCalls) : fakeReaderBundle(chatCalls)) as unknown as KnowledgeBundle;
      },
    };
    const app = createApp({ origin: ORIGIN }, {} as unknown as OperationService, mcpHandleStub, {
      knowledge: { policyPath, access },
    });

    const res = await app.handle(request(`/api/knowledge/${WORKSPACE}/answerChat`, authedJson(askBody)));
    expect(res.status).toBe(200);
    expect(getBundleCalls).toEqual(["content:read"]);
    expect(chatCalls).toEqual(["answerChat"]);
    expect(closeCalls).toEqual([]);
  });

  test("the real access exposes getBundle alone, and the registry marks answerChat a content:read method", () => {
    // Nothing a request can call opens and closes a writer of its own.
    // FUNCTIONS only: the v3 adapter (R18) later added two plain DATA fields
    // (`datasetConfigured`, `indexProfile`) that no request can call. What this
    // pins is that no callable besides getBundle exists to open a writer.
    const access = createKnowledgeAccess({ datasetRoot: undefined }) as Record<string, unknown>;
    expect(Object.keys(access).filter((k) => typeof access[k] === "function")).toEqual(["getBundle"]);
    expect(KNOWLEDGE_METHODS.answerChat!.action).toBe("content:read");
    expect(KNOWLEDGE_METHODS.getChatSettings!.action).toBe("content:read");
    for (const [name, entry] of Object.entries(KNOWLEDGE_METHODS)) {
      expect(Object.hasOwn(entry, "ephemeralWrite"), name).toBe(false);
    }
  });

  test("an ordinary content:write method is UNCHANGED: it still uses the cached getBundle writer, never closed by a request", async () => {
    const getBundleCalls: string[] = [];
    const closeCalls: number[] = [];
    const access: KnowledgeAccess = {
      getBundle: async (action) => {
        getBundleCalls.push(action);
        return fakeWriterBundle(closeCalls) as unknown as KnowledgeBundle;
      },
    };
    const app = createApp({ origin: ORIGIN }, {} as unknown as OperationService, mcpHandleStub, {
      knowledge: { policyPath, access },
    });

    const body = JSON.stringify({ workspace_name: WORKSPACE, session_name: "s1", peer_name: "nat" });
    const res = await app.handle(request(`/api/knowledge/${WORKSPACE}/joinSession`, authedJson(body)));
    expect(res.status).toBe(200);
    expect(getBundleCalls).toEqual(["content:write"]);
    expect(closeCalls).toEqual([]);
  });

  test("a thrown error from the chat facade is a 500 on the reader path, and still no writer was asked for", async () => {
    const getBundleCalls: string[] = [];
    const access: KnowledgeAccess = {
      getBundle: async (action) => {
        getBundleCalls.push(action);
        return {
          ...fakeReaderBundle([]),
          chat: {
            async answerChat() {
              throw new Error("model exploded");
            },
          },
        } as unknown as KnowledgeBundle;
      },
    };
    const app = createApp({ origin: ORIGIN }, {} as unknown as OperationService, mcpHandleStub, {
      knowledge: { policyPath, access },
    });
    const res = await app.handle(request(`/api/knowledge/${WORKSPACE}/answerChat`, authedJson(askBody)));
    expect(res.status).toBe(500);
    expect(getBundleCalls).toEqual(["content:read"]);
  });
});
