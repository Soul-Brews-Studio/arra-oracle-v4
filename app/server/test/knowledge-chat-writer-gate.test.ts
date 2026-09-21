// #33 fix: `answerChat` must never pin the exclusive dataset writer.
//
// THE BUG THIS FILE CATCHES: `answerChat` is declared `action: "content:write"`
// (it is defined only on the writer facade, which alone carries the injected
// `model`) but persists nothing. Before this fix, `handleKnowledgeRequest`
// (knowledge/transport.ts) dispatched it through the SAME
// `ctx.access.getBundle("content:write")` a genuinely persisting write
// (`registerPeer`, `appendMessages`, `publishRevision`, ...) shares. That path
// caches a SUCCESSFUL open for the rest of the process (see
// `createKnowledgeAccess`'s own comment) and never releases it from a request
// path -- so the first `answerChat` call, even one that goes on to fail with
// `invalid_reference` for a nonexistent session, would seize the exclusive
// `OWNERS` gate in `publication/service.ts` and hold it forever. The fix adds
// an `ephemeralWrite` method flag and a `getEphemeralWriter` that opens its
// own, uncached writer and is closed in a `finally` block once the single
// request ends.
//
// WHY THIS IS A SPY TEST, NOT A REAL DATASET: the real gate additionally
// requires an externally-held fd-42 descriptor and matching
// `ARRA_WRITER_FD`/`ARRA_WRITER_ROOT` env vars (`publication/storage.ts`'s
// `assertInheritedGate`, checked BEFORE the in-process `OWNERS` map ever
// runs) -- infrastructure only a real launcher script provides. Standing that
// up needs a spawned child with a specific inherited-fd `stdio` array (see
// `publication-ownership.test.ts`'s `WRITER_TS`/`OWNERS_TS` children); doing
// that here was judged out of scope for a gate-selection regression test.
// This test instead asserts the exact call this bug and its fix are about --
// WHICH `KnowledgeAccess` method the transport invokes, and that whatever it
// opens for `answerChat` is closed exactly once, unconditionally -- via a
// spy `KnowledgeAccess`, not a fake dataset. `OWNERS` itself belongs to a
// dataset-level ownership suite (`publication-ownership.test.ts`), not to a
// transport-routing test.
//
// BITE-TESTED BY HAND before this file was committed: with the ephemeral
// branch in `handleKnowledgeRequest` removed (i.e. `answerChat` routed back
// through `ctx.access.getBundle(entry.action)` unconditionally, as it was
// before this fix), "answerChat never touches the cached getBundle path"
// below FAILS -- `getBundleCalls` records `["content:write"]` instead of
// `[]`. With the fix restored it passes. See the commit message for the
// exact one-line revert used to check this.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { KnowledgeAccess } from "../src/knowledge/transport";
import type { KnowledgeBundle } from "../src/knowledge/registry";
import { parseAnswerChat } from "../src/publication/chat";
import { parseJoinSession } from "../src/publication/context";
import type { OperationService } from "../src/auth/service";
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

/** One fake writer bundle whose `close` is instrumented. `publication` carries
 *  the `publishRevision` probe `registry.ts`'s `isWriterBundle` keys on, the
 *  same shape `knowledge-chat-transport.test.ts` already uses. */
function fakeWriterBundle(closeCalls: number[], id: number) {
  return {
    publication: { publishRevision: (async () => { throw new Error("unused"); }) as never } as never,
    taxonomy: {} as never,
    context: {
      async answerChat(bytes: Uint8Array) {
        parseAnswerChat(bytes); // real governed parser, same discipline as elsewhere
        return { answer: "stub", coverage: "full", excluded: [], items_used: [] };
      },
      async joinSession(bytes: Uint8Array) {
        parseJoinSession(bytes); // real governed parser
        return null;
      },
    } as never,
    evidence: {} as never,
    close: async () => {
      closeCalls.push(id);
    },
  };
}

const mcpHandleStub = (() => {
  throw new Error("unused in this test");
}) as unknown as ReturnType<typeof createMcpAdapter>;

describe("answerChat opens the ephemeral writer, never the cached one", () => {
  test("answerChat never touches the cached getBundle path, and closes what it opened exactly once", async () => {
    const getBundleCalls: string[] = [];
    const closeCalls: number[] = [];
    let ephemeralOpens = 0;
    const access: KnowledgeAccess = {
      getBundle: async (action) => {
        getBundleCalls.push(action);
        // Never reached by this test if the fix holds; present only so a
        // regression that DOES call it gets a real (if wrong) bundle rather
        // than a crash that could be mistaken for the assertion below.
        return fakeWriterBundle(closeCalls, -1) as unknown as KnowledgeBundle;
      },
      getEphemeralWriter: async () => {
        ephemeralOpens += 1;
        return fakeWriterBundle(closeCalls, ephemeralOpens) as never;
      },
    };
    const app = createApp({ origin: ORIGIN }, {} as unknown as OperationService, mcpHandleStub, {
      knowledge: { policyPath, access },
    });

    const body = JSON.stringify({
      workspace_name: WORKSPACE,
      peer_name: "nat",
      session_name: "s1",
      question: "does this leak the writer?",
      max_items: 5,
    });
    const res = await app.handle(request(`/api/knowledge/${WORKSPACE}/answerChat`, authedJson(body)));
    expect(res.status).toBe(200);

    // THE ASSERTION THIS BUG NEEDED: the cached, never-released `getBundle`
    // path was NEVER invoked for this method.
    expect(getBundleCalls).toEqual([]);
    // The ephemeral writer WAS opened exactly once, and closed exactly once
    // -- not left open for a later request to find still held.
    expect(ephemeralOpens).toBe(1);
    expect(closeCalls).toEqual([1]);
  });

  test("an ordinary content:write method is UNCHANGED: it still uses the cached getBundle path, never the ephemeral one", async () => {
    const getBundleCalls: string[] = [];
    const closeCalls: number[] = [];
    let ephemeralOpens = 0;
    const access: KnowledgeAccess = {
      getBundle: async (action) => {
        getBundleCalls.push(action);
        return fakeWriterBundle(closeCalls, -1) as unknown as KnowledgeBundle;
      },
      getEphemeralWriter: async () => {
        ephemeralOpens += 1;
        return fakeWriterBundle(closeCalls, ephemeralOpens) as never;
      },
    };
    const app = createApp({ origin: ORIGIN }, {} as unknown as OperationService, mcpHandleStub, {
      knowledge: { policyPath, access },
    });

    const body = JSON.stringify({ workspace_name: WORKSPACE, session_name: "s1", peer_name: "nat" });
    const res = await app.handle(request(`/api/knowledge/${WORKSPACE}/joinSession`, authedJson(body)));
    expect(res.status).toBe(200);

    expect(getBundleCalls).toEqual(["content:write"]);
    expect(ephemeralOpens).toBe(0);
    // The cached bundle's `close` is NEVER called from a request path (see
    // `createKnowledgeAccess`'s file-header discipline) -- this transport
    // only closes what `getEphemeralWriter` opened.
    expect(closeCalls).toEqual([]);
  });

  test("a thrown error from answerChat still closes the ephemeral writer (finally, not just the happy path)", async () => {
    const closeCalls: number[] = [];
    let ephemeralOpens = 0;
    const access: KnowledgeAccess = {
      getBundle: async () => {
        throw new Error("unused in this test");
      },
      getEphemeralWriter: async () => {
        ephemeralOpens += 1;
        const id = ephemeralOpens;
        return {
          publication: { publishRevision: (async () => { throw new Error("unused"); }) as never } as never,
          taxonomy: {} as never,
          context: {
            async answerChat() {
              throw new Error("model exploded");
            },
          } as never,
          evidence: {} as never,
          close: async () => {
            closeCalls.push(id);
          },
        } as never;
      },
    };
    const app = createApp({ origin: ORIGIN }, {} as unknown as OperationService, mcpHandleStub, {
      knowledge: { policyPath, access },
    });

    const body = JSON.stringify({
      workspace_name: WORKSPACE,
      peer_name: "nat",
      session_name: "s1",
      question: "boom",
      max_items: 5,
    });
    const res = await app.handle(request(`/api/knowledge/${WORKSPACE}/answerChat`, authedJson(body)));
    expect(res.status).toBe(500);
    expect(closeCalls).toEqual([1]);
  });
});
