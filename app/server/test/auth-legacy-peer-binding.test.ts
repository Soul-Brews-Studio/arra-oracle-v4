// #87 / R3 (docs/overnight/DECISIONS.md): the arra-auth/v1 `peers` binding
// covers the LEGACY memories write too.
//
// MCP `remember` and HTTP `POST /api/memories` take a caller-asserted author,
// `peer_name` ("Who wrote it", mcp/tools.ts), and are admitted by the same
// workspace grant as the knowledge methods. R3: "any caller-asserted peer
// (requester, author, observer) must be in it". So a bound grant writes only
// as one of its own peers; `subject_peer_name` is written ABOUT, not acting,
// and stays free, exactly like a revision's subject.
//
// Service level first (the real `createOperationService` over a real policy
// file on a fresh mkdtemp), then the real `createApp` over both transports.
// The store is a recording stub on purpose: the claim is about what reaches
// `insert`, and a refused write must reach nothing at all.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.createApp";
import { AuthDenied, createOperationService, type McpEnvelope, type StoreDependencies } from "../src/auth/service.createOperationService";
import { createMcpAdapter, dispatchTool } from "../src/mcp";
import { EXPIRES_AT, NOT_BEFORE, NOW_MS } from "./helpers/auth-fixture";

const ORIGIN = "http://127.0.0.1:3939";
const BANK = "alpha";

const tokenFor = (label: string) => createHash("sha256").update(`legacy-binding:${label}`).digest("hex");
const TOKENS = { bound: tokenFor("bound"), open: tokenFor("open"), none: tokenFor("none") };

const principal = (id: string, workspace: Record<string, unknown>) => ({
  id,
  disabled: false,
  workspaces: [workspace],
  global_actions: [],
});
const credential = (id: string, token: string) => ({
  id: `cred-${id}`,
  principal_id: id,
  sha256: createHash("sha256").update(token, "ascii").digest("hex"),
  not_before: NOT_BEFORE,
  expires_at: EXPIRES_AT,
  revoked: false,
});

// bound: may write only as `member`; open: no binding (the control);
// none: an EMPTY binding, which binds the grant to no peer at all.
const POLICY = {
  version: "arra-auth/v1",
  principals: [
    principal("bound", { name: BANK, actions: ["content:read", "content:write"], peers: ["member"] }),
    principal("open", { name: BANK, actions: ["content:read", "content:write"] }),
    principal("none", { name: BANK, actions: ["content:write"], peers: [] }),
  ],
  credentials: [credential("bound", TOKENS.bound), credential("open", TOKENS.open), credential("none", TOKENS.none)],
};

let policyDir: string;
let policyPath: string;
const inserted: Array<Record<string, unknown>> = [];
const audit: Array<Record<string, unknown>> = [];

const deps = {
  insert: async (row: Record<string, unknown>) => {
    inserted.push(row);
    return { id: `m-${inserted.length}`, embedded: false };
  },
  logCall: async (row: Record<string, unknown>) => void audit.push(row),
} as unknown as StoreDependencies;

beforeAll(async () => {
  policyDir = await mkdtemp(join(tmpdir(), "arra-v4-legacy-binding-"));
  policyPath = join(policyDir, "policy.json");
  await writeFile(policyPath, JSON.stringify(POLICY), { encoding: "utf-8", mode: 0o600 });
});

afterAll(async () => {
  if (policyDir !== undefined) await rm(policyDir, { recursive: true, force: true });
});

const service = () => createOperationService({ policyPath }, deps, () => NOW_MS);
const bearer = (token: string) => `Bearer ${token}`;

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof AuthDenied ? error.code : `NOT_AUTH_DENIED:${String(error)}`;
  }
  return "NO_THROW";
};

/** Each case starts from an empty recorder, so "reached nothing" is exact. */
const fresh = () => {
  inserted.length = 0;
  audit.length = 0;
};

const row = (fields: Record<string, string>) => ({ name: "spoof-legacy", content: "legacy body", ...fields });

describe("service: insertMemory (HTTP POST /api/memories)", () => {
  test("a bound grant may not write as a peer outside its binding; nothing is stored", async () => {
    fresh();
    const code = await codeOf(() => service().insertMemory(bearer(TOKENS.bound), BANK, () => row({ peer_name: "outsider" })));
    expect(code).toBe("forbidden");
    expect(inserted).toEqual([]);
  });

  test("its own peer, no peer at all, and any SUBJECT are all accepted", async () => {
    fresh();
    await service().insertMemory(bearer(TOKENS.bound), BANK, () => row({ peer_name: "member", subject_peer_name: "outsider" }));
    await service().insertMemory(bearer(TOKENS.bound), BANK, () => row({}));
    expect(inserted.map((r) => [r.peer_name, r.subject_peer_name, r.workspace_name])).toEqual([
      ["member", "outsider", BANK],
      [undefined, undefined, BANK],
    ]);
  });

  test("an empty binding refuses every asserted author but still accepts an anonymous row", async () => {
    fresh();
    expect(await codeOf(() => service().insertMemory(bearer(TOKENS.none), BANK, () => row({ peer_name: "member" })))).toBe(
      "forbidden",
    );
    await service().insertMemory(bearer(TOKENS.none), BANK, () => row({}));
    expect(inserted.length).toBe(1);
  });

  test("no binding: behaviour is unchanged -- any author is stored as asserted", async () => {
    fresh();
    await service().insertMemory(bearer(TOKENS.open), BANK, () => row({ peer_name: "outsider" }));
    expect(inserted.map((r) => r.peer_name)).toEqual(["outsider"]);
  });
});

const remember = (args: Record<string, unknown>) => async (): Promise<McpEnvelope> => ({
  method: "tools/call",
  id: 1,
  params: { name: "remember", arguments: { content: "legacy body", name: "spoof-legacy", ...args } },
});

describe("service: runMcp remember", () => {
  test("a bound grant's spoofed author is a refused, AUDITED tool call; nothing is stored", async () => {
    fresh();
    const result = await service().runMcp(bearer(TOKENS.bound), BANK, remember({ peer_name: "outsider" }), dispatchTool);
    expect(result).toEqual({ kind: "tool_error", message: "forbidden" });
    expect(inserted).toEqual([]);
    expect(audit.map((a) => [a.tool, a.status, a.result])).toEqual([["remember", "error", "forbidden"]]);
  });

  test("its own peer with any subject is stored; no binding stores any author", async () => {
    fresh();
    const own = await service().runMcp(
      bearer(TOKENS.bound),
      BANK,
      remember({ peer_name: "member", subject_peer_name: "outsider" }),
      dispatchTool,
    );
    expect(own.kind).toBe("ok");
    const open = await service().runMcp(bearer(TOKENS.open), BANK, remember({ peer_name: "outsider" }), dispatchTool);
    expect(open.kind).toBe("ok");
    expect(inserted.map((r) => [r.peer_name, r.subject_peer_name])).toEqual([
      ["member", "outsider"],
      ["outsider", undefined],
    ]);
  });
});

describe("live transports: real createApp over HTTP and MCP", () => {
  const app = () => {
    const svc = service();
    return createApp({ origin: ORIGIN }, svc, createMcpAdapter(svc));
  };
  const post = (path: string, token: string, body: unknown) =>
    app().handle(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { host: "127.0.0.1:3939", authorization: bearer(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const memory = (token: string, fields: Record<string, string>) =>
    post("/api/memories", token, { workspace_name: BANK, ...row(fields) });
  const mcpRemember = async (token: string, args: Record<string, unknown>) => {
    const res = await post(`/mcp/${BANK}`, token, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "remember", arguments: { content: "legacy body", ...args } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: body.result.isError === true, text: body.result.content[0]!.text };
  };

  test("POST /api/memories: spoofed author 403 and unstored; own author 201; unbound unchanged", async () => {
    fresh();
    const spoofed = await memory(TOKENS.bound, { peer_name: "outsider" });
    expect(spoofed.status).toBe(403);
    expect(await spoofed.json()).toEqual({ error: "forbidden" });
    expect(inserted).toEqual([]);

    expect((await memory(TOKENS.bound, { peer_name: "member", subject_peer_name: "outsider" })).status).toBe(201);
    expect((await memory(TOKENS.open, { peer_name: "outsider" })).status).toBe(201);
    expect(inserted.map((r) => r.peer_name)).toEqual(["member", "outsider"]);
  });

  test("MCP remember: spoofed author isError and unstored; own author ok; unbound unchanged", async () => {
    fresh();
    const spoofed = await mcpRemember(TOKENS.bound, { peer_name: "outsider" });
    expect(spoofed).toEqual({ isError: true, text: "forbidden" });
    expect(inserted).toEqual([]);

    expect((await mcpRemember(TOKENS.bound, { peer_name: "member" })).isError).toBe(false);
    expect((await mcpRemember(TOKENS.open, { peer_name: "outsider" })).isError).toBe(false);
    expect(inserted.map((r) => r.peer_name)).toEqual(["member", "outsider"]);
  });
});
