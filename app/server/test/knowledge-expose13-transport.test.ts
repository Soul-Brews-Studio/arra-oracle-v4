// #31 overnight R7/R8 (issues #28, #29, #30, #31): wire-level reachability
// and authorization for the 13 methods `registry.ts` used to exclude.
//
// Modelled on `transport-service.test.ts` and `knowledge-chat-transport.test.ts`:
// a REAL `createApp` / REAL `createOperationService` + `createMcpAdapter`
// drive REAL policy admission over a REAL bearer token, through the REAL
// `knowledge/registry.ts` and `mcp/index.ts` dispatch. Only the LanceDB
// storage read below the facade is faked — each fake `context.<method>`
// still calls the REAL governed parser (`session-link.ts`, `trace.ts`,
// `lifecycle.ts`, `search-chunk.ts`) on the exact bytes the transport
// forwards, so every parse-level assertion here exercises real contract
// code. `knowledge-expose13-live.test.ts` proves the real-dataset half.
//
// BEFORE `registry.ts` named these 13 methods: every HTTP call below was 404
// and every `kb_<method>` tool was absent from `tools/list` — measured in
// `.tmp/understand/issue-31/repro.ts`. This file was RED against that state.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { KnowledgeAccess } from "../src/knowledge/transport";
import type { KnowledgeBundle } from "../src/knowledge/registry";
import { KNOWLEDGE_METHODS } from "../src/knowledge/registry";
import { createOperationService, type OperationService, type StoreDependencies } from "../src/auth/service";
import { createMcpAdapter, configureKnowledgeAccess } from "../src/mcp";
import { parseCreateSessionLink, parseListSessionLinks } from "../src/publication/session-link";
import { parseCreateTrace, parseGetTrace, parseListTraceHits } from "../src/publication/trace";
import {
  parseGetRecallEligibility,
  parseListLifecycleHistory,
  parseRetireNode,
  parseSupersedeNode,
} from "../src/publication/lifecycle";
import {
  activeEmbeddingProfileId,
  parseEmbedPendingChunks,
  parseGetSearchFreshness,
  parseIndexRevision,
  parseListChunks,
  parseReconcileSearch,
  parseWriteChunkEmbedding,
} from "../src/publication/search-chunk";

const ORIGIN = "http://127.0.0.1:3939";
const url = (path: string) => `${ORIGIN}${path}`;
const ALPHA = "acme";
const BETA = "other-workspace";

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const sha = (v: string) => createHash("sha256").update(v, "ascii").digest("hex");

const WRITE_TOKEN = "a".repeat(64);
const READ_TOKEN = "b".repeat(64);
const OTHER_WORKSPACE_TOKEN = "c".repeat(64);

const NOT_BEFORE = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

function policyDocument() {
  return {
    version: "arra-auth/v1",
    principals: [
      {
        id: "acme-write",
        disabled: false,
        workspaces: [{ name: ALPHA, actions: ["content:read", "content:write"] }],
        global_actions: [],
      },
      {
        id: "acme-read",
        disabled: false,
        workspaces: [{ name: ALPHA, actions: ["content:read"] }],
        global_actions: [],
      },
      {
        id: "other-write",
        disabled: false,
        workspaces: [{ name: BETA, actions: ["content:read", "content:write"] }],
        global_actions: [],
      },
    ],
    credentials: [
      {
        id: "cred-write",
        principal_id: "acme-write",
        sha256: sha(WRITE_TOKEN),
        not_before: NOT_BEFORE,
        expires_at: EXPIRES_AT,
        revoked: false,
      },
      {
        id: "cred-read",
        principal_id: "acme-read",
        sha256: sha(READ_TOKEN),
        not_before: NOT_BEFORE,
        expires_at: EXPIRES_AT,
        revoked: false,
      },
      {
        id: "cred-other",
        principal_id: "other-write",
        sha256: sha(OTHER_WORKSPACE_TOKEN),
        not_before: NOT_BEFORE,
        expires_at: EXPIRES_AT,
        revoked: false,
      },
    ],
  };
}

/** One minimal, real-parser-valid request body per method, at scopePath []. */
const REQUESTS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  listSessionLinks: {
    workspace_name: ALPHA,
    session_name: "s1",
    direction: "from",
    cursor: null,
    limit: 10,
  },
  createSessionLink: {
    id: pad("sl1"),
    workspace_name: ALPHA,
    from_session_name: "s1",
    to_session_name: "s2",
    relation: "continues",
    evidence_ref: null,
    created_by_peer_name: null,
  },
  getTrace: { workspace_name: ALPHA, id: pad("tr1") },
  listTraceHits: { workspace_name: ALPHA, trace_id: pad("tr1"), after_position: null, limit: 10 },
  createTrace: {
    workspace_name: ALPHA,
    id: pad("tr1"),
    name: "trace-a",
    session_name: null,
    peer_name: null,
    query: "find it",
    mode: null,
    session_id: null,
    session_from_ts: null,
    session_to_ts: null,
    friction_score: null,
    confidence: null,
    parent_id: null,
    prev_id: null,
    depth: "0",
    status: "open",
    h_metadata: null,
    internal_metadata: null,
    hits: [],
  },
  getRecallEligibility: { workspace_name: ALPHA, node_id: pad("node1") },
  listLifecycleHistory: { workspace_name: ALPHA, node_id: pad("node1"), after_event_id: null, limit: 10 },
  retireNode: {
    workspace_name: ALPHA,
    node_id: pad("node1"),
    expected_revision_id: pad("rev1"),
    reason: "no longer needed",
    peer_name: null,
    operation_id: "op-retire-1",
  },
  supersedeNode: {
    workspace_name: ALPHA,
    node_id: pad("node1"),
    expected_revision_id: pad("rev1"),
    new_node_id: pad("node2"),
    new_revision_id: pad("rev2"),
    reason: "superseded",
    peer_name: null,
    operation_id: "op-supersede-1",
  },
  listSearchChunks: {
    workspace_name: ALPHA,
    revision_id: pad("rev1"),
    chunker_version: "chunker/v1",
    embedding_profile: activeEmbeddingProfileId(),
  },
  indexRevisionChunks: {
    workspace_name: ALPHA,
    node_id: pad("node1"),
    revision_id: pad("rev1"),
    chunker_version: "chunker/v1",
    embedding_profile: { name: activeEmbeddingProfileId(), dims: 384 },
  },
  writeChunkEmbedding: {
    workspace_name: ALPHA,
    id: sha("chunk-1"),
    embedding: Array.from({ length: 384 }, () => 0),
  },
  reconcileSearchChunks: { workspace_name: ALPHA, limit: 10 },
  // Fix round nonblocking finding: the transport admission suite was not
  // extended to this slice's two newest registry entries. Verified by hand
  // in scratch (10 pass / 0 fail) but never pinned by a committed test.
  getSearchFreshness: { workspace_name: ALPHA },
  embedPendingChunks: { workspace_name: ALPHA, limit: 10 },
});

const READ_METHODS = [
  "listSessionLinks",
  "getTrace",
  "listTraceHits",
  "getRecallEligibility",
  "listLifecycleHistory",
  "listSearchChunks",
  "getSearchFreshness",
] as const;
const WRITE_METHODS = [
  "createSessionLink",
  "createTrace",
  "retireNode",
  "supersedeNode",
  "indexRevisionChunks",
  "writeChunkEmbedding",
  "reconcileSearchChunks",
  "embedPendingChunks",
] as const;
const ALL_METHODS = [...READ_METHODS, ...WRITE_METHODS];

/** Each fake calls the REAL governed parser on the forwarded bytes, then
 *  returns a canned value — the same technique `transport-service.test.ts`
 *  uses for `getVocabulary`. */
const fakeBundle: KnowledgeBundle = {
  publication: { publishRevision: (async () => { throw new Error("unused"); }) as never } as never,
  taxonomy: {} as never,
  context: {
    async listSessionLinks(bytes: Uint8Array) {
      parseListSessionLinks(bytes);
      return { rows: [], next_cursor: null };
    },
    async createSessionLink(bytes: Uint8Array) {
      parseCreateSessionLink(bytes);
      return { outcome: "created", row: {} };
    },
    async getTrace(bytes: Uint8Array) {
      parseGetTrace(bytes);
      return null;
    },
    async listTraceHits(bytes: Uint8Array) {
      parseListTraceHits(bytes);
      return { rows: [], next_after_position: null };
    },
    async createTrace(bytes: Uint8Array) {
      parseCreateTrace(bytes);
      return { outcome: "created", row: {}, hits: [] };
    },
    async getRecallEligibility(bytes: Uint8Array) {
      parseGetRecallEligibility(bytes);
      return { eligible: true, witness_event_id: "0" };
    },
    async listLifecycleHistory(bytes: Uint8Array) {
      parseListLifecycleHistory(bytes);
      return { rows: [], next_after_event_id: null };
    },
    async retireNode(bytes: Uint8Array) {
      parseRetireNode(bytes);
      return { outcome: "accepted", row: {} };
    },
    async supersedeNode(bytes: Uint8Array) {
      parseSupersedeNode(bytes);
      return { outcome: "accepted", row: {} };
    },
    async listSearchChunks(bytes: Uint8Array) {
      parseListChunks(bytes);
      return [];
    },
    async indexRevisionChunks(bytes: Uint8Array) {
      parseIndexRevision(bytes);
      return { outcome: "indexed", rows: [] };
    },
    async writeChunkEmbedding(bytes: Uint8Array) {
      parseWriteChunkEmbedding(bytes);
      return { outcome: "embedded", row: {} };
    },
    async reconcileSearchChunks(bytes: Uint8Array) {
      parseReconcileSearch(bytes);
      return { visited: 0, missing: 0, missing_revisions: [], stale: 0, exhausted: true };
    },
    async getSearchFreshness(bytes: Uint8Array) {
      parseGetSearchFreshness(bytes);
      return {
        content: { nodes: 0, revisions: 0 },
        text_index: { indexed_rows: null, unindexed_rows: null },
        vectors: {
          profile_id: activeEmbeddingProfileId(),
          pending: 0,
          ready: 0,
          failed: 0,
          last_attempt_at: null,
          model_digest: { pinned: null, last_measured: null },
        },
      };
    },
    async embedPendingChunks(bytes: Uint8Array) {
      parseEmbedPendingChunks(bytes);
      return { attempted: 0, embedded: 0, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null };
    },
  } as never,
  evidence: {} as never,
};

const access: KnowledgeAccess = { getBundle: async () => fakeBundle };

let dataDir: string;
let policyPath: string;
let app: { handle: (request: Request) => Promise<Response> };
let mcpService: OperationService;
let mcpAdapter: ReturnType<typeof createMcpAdapter>;

const request = (path: string, init: RequestInit = {}) =>
  new Request(url(path), { ...init, headers: { host: "127.0.0.1:3939", ...(init.headers ?? {}) } });

const httpCall = (method: string, token: string | null, body: unknown = REQUESTS[method]) =>
  app.handle(
    request(`/api/knowledge/${ALPHA}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  );

async function mcpToolsList(token: string) {
  const outcome = await mcpAdapter(ALPHA, `Bearer ${token}`, async () => ({ method: "tools/list", id: 1, params: {} }));
  if (outcome.kind !== "response") throw new Error(`expected response, got ${JSON.stringify(outcome)}`);
  const body = await outcome.response.json();
  return (body.result.tools as { name: string }[]).map((t) => t.name);
}

async function mcpCall(method: string, token: string, body: unknown = REQUESTS[method]) {
  const outcome = await mcpAdapter(ALPHA, `Bearer ${token}`, async () => ({
    method: "tools/call",
    id: 1,
    params: { name: `kb_${method}`, arguments: { payload: body } },
  }));
  if (outcome.kind === "denied") return { denied: outcome.code };
  const parsed = await outcome.response.json();
  return parsed.result;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "arra-v4-expose13-transport-"));
  policyPath = join(dataDir, "policy.json");
  await writeFile(policyPath, JSON.stringify(policyDocument()), { encoding: "utf-8", mode: 0o600 });

  const memoryService = {} as unknown as OperationService;
  const unusedMcpHandle = (() => {
    throw new Error("unused in this file: /api/knowledge is exercised directly");
  }) as unknown as ReturnType<typeof createMcpAdapter>;
  app = createApp({ origin: ORIGIN }, memoryService, unusedMcpHandle, { knowledge: { policyPath, access } });

  const deps = { logCall: async () => {} } as unknown as StoreDependencies;
  mcpService = createOperationService({ policyPath }, deps);
  configureKnowledgeAccess(access);
  mcpAdapter = createMcpAdapter(mcpService);
});

afterAll(async () => {
  // Module-global singleton (mcp/index.ts) -- unset so a later file in the
  // same process never inherits this test's fake access.
  configureKnowledgeAccess(null);
  await rm(dataDir, { recursive: true, force: true });
});

describe("HTTP: all 13 previously-unreachable methods now answer (not 404)", () => {
  for (const method of ALL_METHODS) {
    test(`POST /api/knowledge/${ALPHA}/${method} is not 404`, async () => {
      const res = await httpCall(method, WRITE_TOKEN);
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
    });
  }

  test("a body naming a different workspace than the route is refused before the facade ever runs", async () => {
    const res = await httpCall("getTrace", WRITE_TOKEN, { workspace_name: BETA, id: pad("tr1") });
    expect(res.status).toBe(400);
  });

  test("no bearer token is unauthenticated on a representative method", async () => {
    const res = await httpCall("createTrace", null);
    expect(res.status).toBe(401);
  });
});

describe("HTTP authorization: content:read-only is refused on every write, wrong workspace is refused on everything", () => {
  for (const method of WRITE_METHODS) {
    test(`content:read-only principal is refused (403) on ${method}`, async () => {
      const res = await httpCall(method, READ_TOKEN);
      expect(res.status).toBe(403);
    });
  }

  for (const method of ALL_METHODS) {
    test(`a principal granted only on ${BETA} is refused (403) on ${method} against ${ALPHA}`, async () => {
      const res = await httpCall(method, OTHER_WORKSPACE_TOKEN);
      expect(res.status).toBe(403);
    });
  }
});

describe("MCP: kb_<method> is listed and dispatchable for all 13", () => {
  test("tools/list for the write-grant token includes every kb_<method>", async () => {
    const names = await mcpToolsList(WRITE_TOKEN);
    for (const method of ALL_METHODS) expect(names).toContain(`kb_${method}`);
  });

  test("tools/list for the read-only token includes the reads but none of the writes", async () => {
    const names = await mcpToolsList(READ_TOKEN);
    for (const method of READ_METHODS) expect(names).toContain(`kb_${method}`);
    for (const method of WRITE_METHODS) expect(names).not.toContain(`kb_${method}`);
  });

  for (const method of ALL_METHODS) {
    test(`tools/call kb_${method} round-trips through the real registry entry`, async () => {
      const result = await mcpCall(method, WRITE_TOKEN);
      expect(result.isError).not.toBe(true);
      expect(typeof result.content[0].text).toBe("string");
    });
  }

  for (const method of WRITE_METHODS) {
    test(`tools/call kb_${method} is denied (forbidden) for the content:read-only principal`, async () => {
      const outcome = await mcpCall(method, READ_TOKEN);
      expect(outcome).toEqual({ denied: "forbidden" });
    });
  }

  for (const method of ALL_METHODS) {
    test(`tools/call kb_${method} is denied for a principal granted only on ${BETA}`, async () => {
      const outcome = await mcpCall(method, OTHER_WORKSPACE_TOKEN);
      expect(outcome).toEqual({ denied: "forbidden" });
    });
  }
});

test("sanity: every method this file exercises really is in KNOWLEDGE_METHODS", () => {
  for (const method of ALL_METHODS) expect(KNOWLEDGE_METHODS[method]).toBeDefined();
});
