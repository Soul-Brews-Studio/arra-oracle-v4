// #87 / R3 (docs/overnight/DECISIONS.md), live over BOTH transports.
//
// Every request goes through a REAL `createApp`: the real Host/Origin guard,
// the real arra-auth/v1 policy file read on every request, the real
// `/api/knowledge/:bank/:method` handler and the real `/mcp/:bank` route with
// the real `createOperationService` four-action projection and
// `createMcpAdapter`. Reads hit a REAL `createKnowledgeAccess` reader over a
// fresh mkdtemp dataset seeded inside the real writer gate
// (`read-boundary-fixture.ts`). Nothing is mocked except the audit sink.
//
// Two policy files, so a binding fault cannot hide the unbound behaviour:
//   plain  -- no grant carries `peers`: reader (content:read only), operator
//             (content:read + audit:read) on alpha, operator on beta;
//   bound  -- grants with a `peers` binding, beside an unbound control.
//
// This test process holds no writer gate, so a WRITE the binding lets through
// answers 503 writer_unavailable: that is the proof the binding refused
// nothing and the ordinary write path ran. A write the binding refuses
// answers 403 BEFORE any writer is opened.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.createApp";
import { createOperationService, type StoreDependencies } from "../src/auth/service.createOperationService";
import { configureKnowledgeAccess, createMcpAdapter } from "../src/mcp";
import { createKnowledgeAccess } from "../src/knowledge/transport";
import type { ContextFixture } from "./helpers/context-fixture";
import { ALPHA, BETA, MAIN_ID, SECRET_ID, createReadBoundaryFixture } from "./helpers/read-boundary-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const TEST_TIMEOUT_MS = testTimeout(300_000);
const ORIGIN = "http://127.0.0.1:3939";

const tokenFor = (label: string) => createHash("sha256").update(`read-boundary:${label}`).digest("hex");
const TOKENS = {
  reader: tokenFor("reader-a"),
  operator: tokenFor("operator-a"),
  operatorBeta: tokenFor("operator-b"),
  bound: tokenFor("bound-a"),
  boundOperator: tokenFor("bound-operator-a"),
  open: tokenFor("open-a"),
};

const grant = (name: string, actions: string[], peers?: string[]) =>
  peers === undefined ? { name, actions } : { name, actions, peers };

const policyDocument = (principals: Array<[id: string, token: string, workspaces: unknown[]]>) => ({
  version: "arra-auth/v1",
  principals: principals.map(([id, , workspaces]) => ({ id, disabled: false, workspaces, global_actions: [] })),
  credentials: principals.map(([id, token]) => ({
    id: `cred-${id}`,
    principal_id: id,
    sha256: createHash("sha256").update(token, "ascii").digest("hex"),
    not_before: "2026-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked: false,
  })),
});

type App = { handle: (request: Request) => Promise<Response> };
type Reply = { status: number; body: any; text: string };

let fixture: ContextFixture;
let policyDir: string;
let plain: App;
let boundApp: App;
const audit: Array<Record<string, unknown>> = [];

const buildApp = async (file: string, document: unknown, access: ReturnType<typeof createKnowledgeAccess>): Promise<App> => {
  const policyPath = join(policyDir, file);
  await writeFile(policyPath, JSON.stringify(document), { encoding: "utf-8", mode: 0o600 });
  const deps = { logCall: async (row: Record<string, unknown>) => void audit.push(row) } as unknown as StoreDependencies;
  const service = createOperationService({ policyPath }, deps);
  return createApp({ origin: ORIGIN }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });
};

beforeAll(async () => {
  fixture = await createReadBoundaryFixture();
  policyDir = await mkdtemp(join(tmpdir(), "arra-v4-read-boundary-policy-"));
  const access = createKnowledgeAccess({ datasetRoot: fixture.datasetRoot });
  configureKnowledgeAccess(access);
  plain = await buildApp(
    "plain.json",
    policyDocument([
      ["reader-a", TOKENS.reader, [grant(ALPHA, ["content:read"])]],
      ["operator-a", TOKENS.operator, [grant(ALPHA, ["content:read", "audit:read"])]],
      ["operator-b", TOKENS.operatorBeta, [grant(BETA, ["content:read", "audit:read"])]],
    ]),
    access,
  );
  boundApp = await buildApp(
    "bound.json",
    policyDocument([
      ["bound-a", TOKENS.bound, [grant(ALPHA, ["content:read", "content:write"], ["peer-a"])]],
      ["bound-operator-a", TOKENS.boundOperator, [grant(ALPHA, ["content:read", "audit:read"], ["peer-a"])]],
      ["open-a", TOKENS.open, [grant(ALPHA, ["content:read", "content:write"])]],
    ]),
    access,
  );
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  configureKnowledgeAccess(null);
  await fixture?.cleanup();
  if (policyDir !== undefined) await rm(policyDir, { recursive: true, force: true });
});

const send = async (app: App, path: string, token: string, body: unknown): Promise<Reply> => {
  const res = await app.handle(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { host: "127.0.0.1:3939", authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  return { status: res.status, body: parsed, text };
};

const http = (app: App, token: string, method: string, body: Record<string, unknown>, bank = ALPHA) =>
  send(app, `/api/knowledge/${bank}/${method}`, token, body);

/** One `tools/call`; returns the tool's own value and whether it was an error. */
const mcp = async (app: App, token: string, method: string, payload: Record<string, unknown>, bank = ALPHA) => {
  const reply = await send(app, `/mcp/${bank}`, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: `kb_${method}`, arguments: { payload } },
  });
  expect(reply.status, reply.text).toBe(200);
  const result = reply.body.result as { isError?: boolean; content: Array<{ text: string }> };
  const raw = result.content[0]!.text;
  let value: any = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // a plain-text tool error stays text
  }
  return { isError: result.isError === true, value, text: reply.text };
};

const list = (session: string, requester?: string) => ({
  workspace_name: ALPHA,
  session_name: session,
  after_seq: null,
  limit: 10,
  ...(requester === undefined ? {} : { requester_peer_name: requester }),
});
const get = (publicId: string, requester?: string, workspace = ALPHA) => ({
  workspace_name: workspace,
  public_id: publicId,
  ...(requester === undefined ? {} : { requester_peer_name: requester }),
});
const context = (peer: string, session: string) => ({
  workspace_name: ALPHA,
  peer_name: peer,
  session_name: session,
  max_items: 10,
});

const envelope = (code: string, path: string) =>
  expect.objectContaining({ version: "arra-publication-error/v1", code, path });
const rowsOf = (reply: Reply) => (reply.body.rows as Array<{ content: string }>).map((row) => row.content);

describe("HTTP: listMessages/getMessage read boundary", () => {
  test("no requester: content:read only is 403, audit:read is the operator view", async () => {
    const listed = await http(plain, TOKENS.reader, "listMessages", list("sess-secret"));
    expect(listed.status, listed.text).toBe(403);
    expect(listed.body).toEqual(envelope("forbidden", "/requester_peer_name"));
    const got = await http(plain, TOKENS.reader, "getMessage", get(SECRET_ID));
    expect(got.status, got.text).toBe(403);
    expect(got.body).toEqual(envelope("forbidden", "/requester_peer_name"));
    expect(listed.text + got.text).not.toContain("SECRET-");

    const operatorList = await http(plain, TOKENS.operator, "listMessages", list("sess-secret"));
    expect(operatorList.status, operatorList.text).toBe(200);
    expect(rowsOf(operatorList)).toEqual(["SECRET-alpha"]);
    const operatorGet = await http(plain, TOKENS.operator, "getMessage", get(SECRET_ID));
    expect(operatorGet.status, operatorGet.text).toBe(200);
    expect(operatorGet.body.content).toBe("SECRET-alpha");
  }, TEST_TIMEOUT_MS);

  test("non-member and departed requesters are denied; a current member reads", async () => {
    for (const requester of ["peer-a", "peer-c"]) {
      const listed = await http(plain, TOKENS.reader, "listMessages", list("sess-secret", requester));
      expect(listed.status, listed.text).toBe(400);
      expect(listed.body).toEqual(envelope("invalid_reference", "/requester_peer_name"));
      const got = await http(plain, TOKENS.reader, "getMessage", get(SECRET_ID, requester));
      expect(got.status, got.text).toBe(200);
      expect(got.body).toBeNull();
    }
    const member = await http(plain, TOKENS.reader, "listMessages", list("sess-secret", "peer-b"));
    expect(member.status, member.text).toBe(200);
    expect(rowsOf(member)).toEqual(["SECRET-alpha"]);
    const memberGet = await http(plain, TOKENS.reader, "getMessage", get(SECRET_ID, "peer-b"));
    expect(memberGet.status, memberGet.text).toBe(200);
    expect(memberGet.body.content).toBe("SECRET-alpha");
  }, TEST_TIMEOUT_MS);

  test("colliding public_id and session names stay in their own workspace", async () => {
    const beta = await http(plain, TOKENS.operatorBeta, "getMessage", get(SECRET_ID, undefined, BETA), BETA);
    expect(beta.status, beta.text).toBe(200);
    expect(beta.body.content).toBe("SECRET-beta");
    const betaMember = await http(plain, TOKENS.operatorBeta, "listMessages", { ...list("sess-secret", "peer-a"), workspace_name: BETA }, BETA);
    expect(rowsOf(betaMember)).toEqual(["SECRET-beta"]);
    // peer-a's beta membership opens nothing in alpha.
    const alpha = await http(plain, TOKENS.reader, "getMessage", get(SECRET_ID, "peer-a"));
    expect(alpha.body).toBeNull();
    // Route scope still decides the grant: an alpha operator cannot read beta,
    // and a beta route cannot carry an alpha body.
    expect((await http(plain, TOKENS.operator, "getMessage", get(SECRET_ID, undefined, BETA), BETA)).status).toBe(403);
    expect((await http(plain, TOKENS.operatorBeta, "getMessage", get(SECRET_ID), BETA)).status).toBe(400);
  }, TEST_TIMEOUT_MS);
});

describe("MCP: kb_listMessages/kb_getMessage read boundary", () => {
  test("the same rules hold through tools/call", async () => {
    const denied = await mcp(plain, TOKENS.reader, "listMessages", list("sess-secret"));
    expect(denied.isError, denied.text).toBe(true);
    expect(denied.value).toEqual(envelope("forbidden", "/requester_peer_name"));
    const deniedGet = await mcp(plain, TOKENS.reader, "getMessage", get(SECRET_ID));
    expect(deniedGet.value).toEqual(envelope("forbidden", "/requester_peer_name"));
    expect(denied.text + deniedGet.text).not.toContain("SECRET-");

    const nonMember = await mcp(plain, TOKENS.reader, "listMessages", list("sess-secret", "peer-a"));
    expect(nonMember.isError).toBe(true);
    expect(nonMember.value).toEqual(envelope("invalid_reference", "/requester_peer_name"));
    const departed = await mcp(plain, TOKENS.reader, "getMessage", get(SECRET_ID, "peer-c"));
    expect(departed).toMatchObject({ isError: false, value: null });

    const member = await mcp(plain, TOKENS.reader, "getMessage", get(SECRET_ID, "peer-b"));
    expect(member.isError, member.text).toBe(false);
    expect(member.value.content).toBe("SECRET-alpha");
    const operator = await mcp(plain, TOKENS.operator, "listMessages", list("sess-secret"));
    expect(operator.isError, operator.text).toBe(false);
    expect(operator.value.rows.map((r: { content: string }) => r.content)).toEqual(["SECRET-alpha"]);
    const beta = await mcp(plain, TOKENS.operatorBeta, "getMessage", get(SECRET_ID, undefined, BETA), BETA);
    expect(beta.value.content).toBe("SECRET-beta");
  }, TEST_TIMEOUT_MS);

  test("tools/list describes the requester and the audit:read operator view", async () => {
    const reply = await send(plain, `/mcp/${ALPHA}`, TOKENS.reader, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = reply.body.result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    for (const name of ["kb_listMessages", "kb_getMessage"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.description).toContain("requester_peer_name");
      expect(tool!.description).toContain("audit:read");
      expect(tool!.inputSchema.properties.payload.properties.requester_peer_name.type).toBe("string");
    }
  }, TEST_TIMEOUT_MS);
});

describe("arra-auth/v1 peers binding, both transports", () => {
  test("a bound principal may not assert another peer as requester", async () => {
    const listed = await http(boundApp, TOKENS.bound, "listMessages", list("sess-secret", "peer-b"));
    expect(listed.status, listed.text).toBe(403);
    expect(listed.body).toEqual(envelope("forbidden", "/requester_peer_name"));
    const viaMcp = await mcp(boundApp, TOKENS.bound, "getMessage", get(SECRET_ID, "peer-b"));
    expect(viaMcp.value).toEqual(envelope("forbidden", "/requester_peer_name"));
    expect(listed.text + viaMcp.text).not.toContain("SECRET-");
    // Its own peer reads its own session.
    const own = await http(boundApp, TOKENS.bound, "listMessages", list("sess-main", "peer-a"));
    expect(own.status, own.text).toBe(200);
    expect(rowsOf(own)).toEqual(["main-alpha"]);
    const ownGet = await mcp(boundApp, TOKENS.bound, "getMessage", get(MAIN_ID, "peer-a"));
    expect(ownGet.value.content).toBe("main-alpha");
  }, TEST_TIMEOUT_MS);

  test("getContext and answerChat requesters are bound too", async () => {
    const ctx = await http(boundApp, TOKENS.bound, "getContext", context("peer-b", "sess-secret"));
    expect(ctx.status, ctx.text).toBe(403);
    expect(ctx.body).toEqual(envelope("forbidden", "/peer_name"));
    const ctxMcp = await mcp(boundApp, TOKENS.bound, "getContext", context("peer-b", "sess-secret"));
    expect(ctxMcp.value).toEqual(envelope("forbidden", "/peer_name"));
    expect(ctx.text + ctxMcp.text).not.toContain("SECRET-");
    const chat = await http(boundApp, TOKENS.bound, "answerChat", { ...context("peer-b", "sess-secret"), question: "what is secret?" });
    expect(chat.status, chat.text).toBe(403);
    expect(chat.body).toEqual(envelope("forbidden", "/peer_name"));
    const own = await http(boundApp, TOKENS.bound, "getContext", context("peer-a", "sess-main"));
    expect(own.status, own.text).toBe(200);
    expect(own.body.items.map((i: { content: string }) => i.content)).toEqual(["main-alpha"]);
  }, TEST_TIMEOUT_MS);

  test("appendMessages authors, publishRevision author/observer and read-cursor peers are bound", async () => {
    const item = (peer: string) => ({
      public_id: "boundappendboundappen",
      message: { peer_name: peer, role: null, content: "spoofed", in_reply_to: null },
      source: null,
    });
    const append = (peer: string) => ({ workspace_name: ALPHA, session_name: "sess-main", items: [item("peer-a"), item(peer)] });
    const spoofed = await http(boundApp, TOKENS.bound, "appendMessages", append("peer-b"));
    expect(spoofed.status, spoofed.text).toBe(403);
    expect(spoofed.body).toEqual(envelope("forbidden", "/items/1/message/peer_name"));
    const spoofedMcp = await mcp(boundApp, TOKENS.bound, "appendMessages", append("peer-b"));
    expect(spoofedMcp.value).toEqual(envelope("forbidden", "/items/1/message/peer_name"));
    // Its own peer passes the binding and reaches the ordinary write path,
    // which this gate-less process cannot open.
    const own = await http(boundApp, TOKENS.bound, "appendMessages", append("peer-a"));
    expect(own.status, own.text).toBe(503);

    const revision = (author: string, observer: string | null) => ({
      operation_id: "bound-revision",
      content: { workspace_name: ALPHA, author_peer_name: author, observer_peer_name: observer },
    });
    const author = await http(boundApp, TOKENS.bound, "publishRevision", revision("peer-b", null));
    expect(author.status, author.text).toBe(403);
    expect(author.body).toEqual(envelope("forbidden", "/content/author_peer_name"));
    const observer = await http(boundApp, TOKENS.bound, "publishRevision", revision("peer-a", "peer-c"));
    expect(observer.status, observer.text).toBe(403);
    expect(observer.body).toEqual(envelope("forbidden", "/content/observer_peer_name"));

    const cursor = (peer: string) => ({ workspace_name: ALPHA, session_name: "sess-main", peer_name: peer });
    const otherCursor = await http(boundApp, TOKENS.bound, "getReadCursor", cursor("peer-b"));
    expect(otherCursor.status, otherCursor.text).toBe(403);
    expect(otherCursor.body).toEqual(envelope("forbidden", "/peer_name"));
    const ownCursor = await http(boundApp, TOKENS.bound, "getReadCursor", cursor("peer-a"));
    expect(ownCursor.status, ownCursor.text).toBe(200);
    const join = await http(boundApp, TOKENS.bound, "joinSession", cursor("peer-b"));
    expect(join.status, join.text).toBe(403);
  }, TEST_TIMEOUT_MS);

  test("no binding: behaviour is unchanged; a binding never blocks the operator view", async () => {
    const open = await http(boundApp, TOKENS.open, "getContext", context("peer-b", "sess-secret"));
    expect(open.status, open.text).toBe(200);
    expect(open.body.items.map((i: { content: string }) => i.content)).toEqual(["SECRET-alpha"]);
    const openList = await http(boundApp, TOKENS.open, "listMessages", list("sess-secret", "peer-b"));
    expect(rowsOf(openList)).toEqual(["SECRET-alpha"]);
    const openWrite = await http(boundApp, TOKENS.open, "appendMessages", {
      workspace_name: ALPHA,
      session_name: "sess-main",
      items: [{ public_id: "openappendopenappendo", message: { peer_name: "peer-c", role: null, content: "x", in_reply_to: null }, source: null }],
    });
    expect(openWrite.status, openWrite.text).toBe(503);

    // Operator view asserts no peer, so the binding has nothing to refuse...
    const operatorView = await http(boundApp, TOKENS.boundOperator, "listMessages", list("sess-secret"));
    expect(operatorView.status, operatorView.text).toBe(200);
    expect(rowsOf(operatorView)).toEqual(["SECRET-alpha"]);
    // ...but a requester it names is still bound.
    const named = await http(boundApp, TOKENS.boundOperator, "listMessages", list("sess-secret", "peer-b"));
    expect(named.status, named.text).toBe(403);
  }, TEST_TIMEOUT_MS);
});
