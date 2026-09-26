// Slice V0 -- the v3-compatible MCP frame (#31 legacy adapters,
// docs/overnight/V3-PARITY.md §2, §3 A1-A3, §7 "V0"; DECISIONS.md R18).
//
// Written BEFORE `src/mcp/legacy-v3/` existed. The wire half drives the REAL
// `createApp` -> `POST /mcp/:bank` -> `createOperationService` ->
// `createMcpAdapter` path over a REAL 0600 policy file; only storage below
// the knowledge facade is a recording fake, the same technique
// `knowledge-expose13-transport.test.ts` uses. No dataset, no gate.
//
// Also pins parity defects 5 (kb_* advertised with no dataset) and 6 (the
// dead duplicate action map in mcp/index.ts), and D1 (legacy node ids).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createOperationService, type StoreDependencies } from "../src/auth/service";
import { KNOWLEDGE_METHODS, type KnowledgeBundle } from "../src/knowledge/registry";
import { createKnowledgeAccess, type KnowledgeAccess } from "../src/knowledge/transport";
import * as mcpModule from "../src/mcp";
import { configureKnowledgeAccess, createMcpAdapter } from "../src/mcp";

const ORIGIN = "http://127.0.0.1:3939";
const BANK = "bank-a";
const sha = (v: string) => createHash("sha256").update(v, "ascii").digest("hex");
const TOKENS = { rw: "7".repeat(64), ro: "8".repeat(64), wo: "9".repeat(64) } as const;
const NOT_CARRIED = ["oracle_mcp_call", "oracle_mcp_list_tools", "oracle_trace_link", "oracle_trace_unlink", "oracle_profile"];
const WRITE_FAMILY = [
  "oracle_learn", "oracle_research_note", "oracle_handoff", "oracle_supersede", "oracle_thread",
  "oracle_thread_update", "oracle_trace", "oracle_trace_distill", "oracle_search_chain", "oracle_verify",
];
const TENANT_AND_SCOPE_CARRIERS = ["tenantId", "tenant_id", "tenant", "orgId", "org_id", "workspace_name", "bank", "workspace"];

let dir: string;
let policyPath: string;
let audit: Record<string, unknown>[] = [];
const deps = { logCall: async (r: Record<string, unknown>) => void audit.push(r) } as unknown as StoreDependencies;

/** A configured knowledge dataset whose bundle records calls; nothing is stored. */
const calls: string[] = [];
const fakeBundle = new Proxy({}, {
  get: (_t, facade) => new Proxy({}, { get: (_u, method) => async () => void calls.push(`${String(facade)}.${String(method)}`) }),
}) as unknown as KnowledgeBundle;
const configured: KnowledgeAccess = { getBundle: async () => fakeBundle };
/** A READER-shaped bundle (no publishRevision) whose #30 searches answer nothing. */
const searchable: KnowledgeAccess = {
  getBundle: async () => ({
    publication: {},
    context: { searchKnowledgeKeyword: async () => ({ match: "ngram", scan_reason: null, hits: [] }) },
  }) as unknown as KnowledgeBundle,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "arra-v3-frame-"));
  policyPath = join(dir, "policy.json");
  const credential = (who: keyof typeof TOKENS) => ({
    id: `cred-${who}`, principal_id: who, sha256: sha(TOKENS[who]),
    not_before: "2020-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", revoked: false,
  });
  await writeFile(policyPath, JSON.stringify({
    version: "arra-auth/v1",
    principals: [
      { id: "rw", disabled: false, workspaces: [{ name: BANK, actions: ["content:read", "content:write"], peers: ["neo"] }], global_actions: [] },
      { id: "ro", disabled: false, workspaces: [{ name: BANK, actions: ["content:read"] }], global_actions: [] },
      { id: "wo", disabled: false, workspaces: [{ name: BANK, actions: ["content:write"] }], global_actions: [] },
    ],
    credentials: [credential("rw"), credential("ro"), credential("wo")],
  }), { encoding: "utf-8", mode: 0o600 });
});

afterEach(() => {
  audit = [];
  calls.length = 0;
  configureKnowledgeAccess(null);
});
afterAll(async () => {
  configureKnowledgeAccess(null);
  await rm(dir, { recursive: true, force: true });
});

function appWith(v3Compat: boolean) {
  const service = createOperationService({ policyPath, v3Compat }, deps);
  return { service, app: createApp({ origin: ORIGIN, v3Compat }, service, createMcpAdapter(service)) };
}

async function rpc(v3Compat: boolean, who: keyof typeof TOKENS, body: Record<string, unknown>, peer?: string) {
  const { app } = appWith(v3Compat);
  const headers: Record<string, string> = { host: "127.0.0.1:3939", "content-type": "application/json", authorization: `Bearer ${TOKENS[who]}` };
  if (peer !== undefined) headers["x-arra-peer"] = peer;
  const res = await app.handle(new Request(`${ORIGIN}/mcp/${BANK}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) }));
  return { status: res.status, json: (await res.json()) as any };
}
const list = async (v3Compat: boolean, who: keyof typeof TOKENS) =>
  ((await rpc(v3Compat, who, { method: "tools/list", params: {} })).json.result.tools as { name: string }[]).map((t) => t.name);
const call = (v3Compat: boolean, who: keyof typeof TOKENS, name: string, args: unknown = {}, peer?: string) =>
  rpc(v3Compat, who, { method: "tools/call", params: { name, arguments: args } }, peer);
const toolText = (res: { json: any }) => res.json.result.content[0].text as string;

describe("V0 #1: the family flag is off by default", () => {
  test("with the flag off, no v3 name is listed and calling one is 403 like an unknown tool", async () => {
    configureKnowledgeAccess(configured);
    const names = await list(false, "rw");
    expect(names.filter((n) => n.startsWith("oracle_") || n.startsWith("____"))).toEqual([]);
    const guide = await call(false, "rw", "____IMPORTANT");
    const unknown = await call(false, "rw", "oracle_nope");
    expect(guide.status).toBe(403);
    expect(guide).toEqual(unknown);
  });

  test("composition reads ARRA_MCP_V3_COMPAT as trusted configuration: only '1' turns it on", async () => {
    const { composeV3Compat } = await import("../src/composition");
    expect(composeV3Compat({})).toBe(false);
    expect(composeV3Compat({ ARRA_MCP_V3_COMPAT: "0" })).toBe(false);
    expect(composeV3Compat({ ARRA_MCP_V3_COMPAT: "true" })).toBe(false);
    expect(composeV3Compat({ ARRA_MCP_V3_COMPAT: "1" })).toBe(true);
  });
});

describe("V0 #2: grants decide the family; not-carried tools do not exist", () => {
  test("a content:read-only grant lists read-family tools only", async () => {
    configureKnowledgeAccess(configured);
    const ro = await list(true, "ro");
    expect(ro).toContain("____IMPORTANT");
    for (const name of WRITE_FAMILY) expect(ro).not.toContain(name);
  });

  test("the five not-carried tools are never listed, and calling one is byte-identical to an unknown tool", async () => {
    configureKnowledgeAccess(configured);
    const rw = await list(true, "rw");
    const unknown = await call(true, "rw", "oracle_nope");
    expect(unknown.status).toBe(403);
    for (const name of NOT_CARRIED) {
      expect(rw).not.toContain(name);
      expect(await call(true, "rw", name, { command: "sh", args: ["-c", "id"] })).toEqual(unknown);
    }
  });
});

describe("V0 #2b: a write tool whose answer is bank content needs content:read too (exact grants)", () => {
  test("content:write alone lists the write family but not oracle_search_chain, and calling it is an unknown tool's 403", async () => {
    configureKnowledgeAccess(configured);
    const wo = await list(true, "wo");
    expect(wo).toContain("oracle_learn");
    expect(wo).not.toContain("oracle_search");
    expect(wo).not.toContain("oracle_search_chain");
    expect(await list(true, "rw")).toContain("oracle_search_chain");
    const unknown = await call(true, "wo", "oracle_nope");
    expect(unknown.status).toBe(403);
    expect(await call(true, "wo", "oracle_search_chain", { query: "x" })).toEqual(unknown);
    expect(calls).toEqual([]);
    expect(audit).toEqual([]);
  });
});

describe("V0 #3 and #4: availability is data-driven (V3-PARITY §2.1 rules b and c)", () => {
  test("a tool is listed exactly when its requires are registered and it has a handler; an unlisted one is not_yet_available", async () => {
    const { V3_CATALOGUE } = await import("../src/mcp/legacy-v3/catalogue");
    const { V3_HANDLERS } = await import("../src/mcp/legacy-v3/handlers");
    // Whichever tools still wait on a kernel slice or a handler: the rule is
    // pinned, not one example tool, so it holds when every tool is built.
    const pending = V3_CATALOGUE.filter((t) => t.requires.some((m) => !(m in KNOWLEDGE_METHODS)) || !(t.name in V3_HANDLERS));
    configureKnowledgeAccess(configured);
    const listed = await list(true, "rw");
    for (const tool of V3_CATALOGUE) expect([tool.name, listed.includes(tool.name)]).toEqual([tool.name, !pending.includes(tool)]);
    for (const tool of pending) {
      const res = await call(true, "rw", tool.name, {});
      expect(res.status).toBe(200);
      expect(res.json.result.isError).toBe(true);
      const body = JSON.parse(toolText(res));
      expect(body.success).toBe(false);
      expect(body.compat).toMatchObject({ version: "arra-v3-compat/1", code: "not_yet_available", tool: tool.name });
    }
    expect(calls).toEqual([]);
  });

  test("with no dataset configured, neither the v3 family nor kb_* is listed (defect 5)", async () => {
    for (const access of [null, createKnowledgeAccess({ datasetRoot: undefined })]) {
      configureKnowledgeAccess(access);
      const names = await list(true, "rw");
      expect(names.filter((n) => n.startsWith("oracle_") || n.startsWith("____") || n.startsWith("kb_"))).toEqual([]);
      expect(names).toContain("remember");
    }
    configureKnowledgeAccess(createKnowledgeAccess({ datasetRoot: "/nonexistent-but-configured" }));
    expect(await list(true, "rw")).toContain("kb_getAcceptedHead");
  });
});

describe("V0 #5: inbound arra_* aliases (D6)", () => {
  test("arra_search runs as oracle_search under oracle_search's action, is never listed, and is audited canonically", async () => {
    configureKnowledgeAccess(searchable);
    const names = await list(true, "ro");
    expect(names.filter((n) => n.startsWith("arra_"))).toEqual([]);
    const res = await call(true, "ro", "arra_search", { query: "x" });
    const direct = await call(true, "ro", "oracle_search", { query: "x" });
    expect(res.status).toBe(200);
    expect(res.json.result.isError).toBeUndefined();
    const timeless = (text: string) => ({ ...JSON.parse(text), metadata: { ...JSON.parse(text).metadata, searchTime: 0 } });
    expect(timeless(toolText(res))).toEqual(timeless(toolText(direct)));
    expect(audit[0]).toMatchObject({ tool: "oracle_search", requested_as: "arra_search", status: "ok" });
  });

  test("an alias never widens a grant, and muninn_* stays unknown", async () => {
    configureKnowledgeAccess(configured);
    const unknown = await call(true, "ro", "oracle_nope");
    expect(await call(true, "ro", "arra_learn", { pattern: "x" })).toEqual(unknown);
    expect(await call(true, "rw", "muninn_search", { query: "x" })).toEqual(await call(true, "rw", "oracle_nope"));
    expect(await call(false, "rw", "arra_search", { query: "x" })).toEqual(await call(false, "rw", "oracle_nope"));
  });
});

describe("V0 #6: scope and tenant carriers are refused (A2)", () => {
  for (const key of TENANT_AND_SCOPE_CARRIERS) {
    test(`${key} in arguments is an arra-v3-compat/1 unsupported_argument`, async () => {
      configureKnowledgeAccess(configured);
      const res = await call(true, "rw", "____IMPORTANT", { [key]: "t" });
      expect(res.json.result.isError).toBe(true);
      expect(JSON.parse(toolText(res)).compat).toMatchObject({ code: "unsupported_argument", tool: "____IMPORTANT", path: `/${key}` });
    });
  }
});

describe("V0 #7: the catalogue and the service agree (A1)", () => {
  const RANK: Record<string, number> = { "content:read": 0, "content:write": 1 };
  const violations = (catalogue: readonly { name: string; action: string; uses: readonly string[]; requires: readonly string[] }[], action: (n: string) => string | undefined) => {
    const out: string[] = [];
    for (const tool of catalogue) {
      if (action(tool.name) !== tool.action) out.push(`${tool.name}: service action ${action(tool.name)} != ${tool.action}`);
      for (const m of tool.uses) {
        const methodAction = KNOWLEDGE_METHODS[m]?.action;
        if (methodAction !== undefined && !(RANK[methodAction]! <= RANK[tool.action]!)) out.push(`${tool.name} uses ${m} (${methodAction})`);
      }
      for (const m of tool.requires) if (!tool.uses.includes(m)) out.push(`${tool.name} requires ${m} but may not call it`);
    }
    return out;
  };

  test("every tool's action equals the service map, and no tool may call a method above its action", async () => {
    const { V3_CATALOGUE } = await import("../src/mcp/legacy-v3/catalogue");
    const { toolAction } = await import("../src/auth/service.toolAction");
    expect(V3_CATALOGUE.map((t) => t.name).sort()).toEqual([
      "____IMPORTANT", "oracle_ask", "oracle_concepts", "oracle_handoff", "oracle_inbox", "oracle_learn", "oracle_list",
      "oracle_read", "oracle_recap", "oracle_reflect", "oracle_research_note", "oracle_search", "oracle_search_chain",
      "oracle_stats", "oracle_supersede", "oracle_thread", "oracle_thread_read", "oracle_thread_update", "oracle_threads",
      "oracle_trace", "oracle_trace_chain", "oracle_trace_distill", "oracle_trace_get", "oracle_trace_list", "oracle_verify",
    ]);
    expect(violations(V3_CATALOGUE, (n) => toolAction(n, true))).toEqual([]);
    for (const tool of V3_CATALOGUE) expect(toolAction(tool.name, false)).toBeUndefined();
    // Mutating one entry must fail the same check.
    const mutated = V3_CATALOGUE.map((t) => (t.name === "oracle_read" ? { ...t, uses: [...t.uses, "publishRevision"] } : t));
    expect(violations(mutated, (n) => toolAction(n, true))).toEqual(["oracle_read uses publishRevision (content:write)"]);
    const relabelled = V3_CATALOGUE.map((t) => (t.name === "oracle_learn" ? { ...t, action: "content:read" } : t));
    expect(violations(relabelled, (n) => toolAction(n, true)).length).toBeGreaterThan(0);
  });
});

describe("V0 #8: kb() is the only capability, and it is bounded", () => {
  const ctx = (action: "content:read" | "content:write", uses: string[]) => ({
    spec: { name: "oracle_probe", action, uses, requires: [], description: "", inputSchema: { type: "object" } },
    bank: BANK, authority: { operator: false, peers: null }, access: configured,
  });

  test("a method outside `uses` is refused before any bundle is touched", async () => {
    const { createKb } = await import("../src/mcp/legacy-v3/createKb");
    const kb = createKb(ctx("content:read", ["getAcceptedHead"]));
    await expect(kb("listNodes", {})).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("a read tool may not call a write method even if its `uses` names one", async () => {
    const { createKb } = await import("../src/mcp/legacy-v3/createKb");
    const kb = createKb(ctx("content:read", ["publishRevision"]));
    await expect(kb("publishRevision", { operation_id: "x", content: {} })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("workspace_name is set from the route bank, and a payload naming another workspace is refused", async () => {
    const { createKb } = await import("../src/mcp/legacy-v3/createKb");
    const kb = createKb(ctx("content:read", ["getAcceptedHead"]));
    await kb("getAcceptedHead", { node_id: "n" });
    expect(calls).toEqual(["publication.getAcceptedHead"]);
    await expect(kb("getAcceptedHead", { workspace_name: "bank-b", node_id: "n" })).rejects.toThrow();
    expect(calls).toEqual(["publication.getAcceptedHead"]);
  });
});

describe("V0 #9 and #10: errors, audit and the speaker header", () => {
  test("a CompatError crosses runMcp as exact JSON with isError, and the audit row says error", async () => {
    configureKnowledgeAccess(configured);
    // No query: oracle_search refuses before any kernel call.
    const res = await call(true, "rw", "oracle_search", {});
    const body = JSON.parse(toolText(res));
    expect(Object.keys(body).sort()).toEqual(["compat", "error", "success", "v4_error"]);
    expect(body.v4_error).toBeNull();
    expect(typeof body.error).toBe("string");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: "oracle_search", status: "error" });
    expect(JSON.parse(audit[0]!.result as string)).toEqual(body);
  });

  test("X-Arra-Peer outside the grant's peers binding is refused; a bound one reaches ops and the audit row", async () => {
    configureKnowledgeAccess(configured);
    const refused = await call(true, "rw", "____IMPORTANT", {}, "nat");
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: "forbidden" });
    expect(audit).toEqual([]);
    const ok = await call(true, "rw", "____IMPORTANT", {}, "neo");
    expect(ok.status).toBe(200);
    expect(audit.at(-1)).toMatchObject({ tool: "____IMPORTANT", status: "ok", peer_name: "neo" });
  });

  test("with no header the asserted peer is null; the header never comes from the bearer", async () => {
    const service = createOperationService({ policyPath, v3Compat: true }, deps);
    const seen: unknown[] = [];
    const envelope = async () => ({ method: "tools/call", id: 1, params: { name: "____IMPORTANT", arguments: {} } });
    await service.runMcp(`Bearer ${TOKENS.rw}`, BANK, envelope, async (_n, _a, ops) => void seen.push(ops.assertedPeer));
    await service.runMcp(`Bearer ${TOKENS.ro}`, BANK, envelope, async (_n, _a, ops) => void seen.push(ops.assertedPeer), "", "anyone");
    expect(seen).toEqual([null, "anyone"]);
  });

  test("a malformed X-Arra-Peer is a 400 before any policy work", async () => {
    configureKnowledgeAccess(configured);
    expect((await call(true, "rw", "____IMPORTANT", {}, "   ")).status).toBe(400);
    expect((await call(true, "rw", "____IMPORTANT", {}, "x".repeat(257))).status).toBe(400);
  });

  test("with the flag off the header is not read at all: no 400, no 403, no audit peer (base behavior)", async () => {
    configureKnowledgeAccess(configured);
    const bare = await rpc(false, "rw", { method: "tools/list", params: {} });
    for (const peer of ["   ", "x".repeat(257), "nat"]) {
      expect(await rpc(false, "rw", { method: "tools/list", params: {} }, peer)).toEqual(bare);
    }
    const payload = { payload: { workspace_name: BANK, node_id: "n".repeat(21) } };
    await call(false, "rw", "kb_getAcceptedHead", payload, "nat");
    await call(false, "rw", "kb_getAcceptedHead", payload, "neo");
    expect(audit).toHaveLength(2);
    for (const row of audit) expect(row).toMatchObject({ tool: "kb_getAcceptedHead", peer_name: null });
    // The service drops it too, whatever a caller of runMcp passes.
    const service = createOperationService({ policyPath, v3Compat: false }, deps);
    const seen: unknown[] = [];
    const envelope = async () => ({ method: "tools/call", id: 1, params: { name: "kb_getAcceptedHead", arguments: payload } });
    const result = await service.runMcp(`Bearer ${TOKENS.rw}`, BANK, envelope, async (_n, _a, ops) => void seen.push(ops.assertedPeer), "", "nat");
    expect(result.kind).toBe("ok");
    expect(seen).toEqual([null]);
  });
});

describe("V0 #11: ____IMPORTANT is the v4 guide", () => {
  test("it is plain text naming what is not carried and what leaves recall", async () => {
    configureKnowledgeAccess(configured);
    const res = await call(true, "ro", "____IMPORTANT");
    expect(res.json.result.isError).toBeUndefined();
    const text = toolText(res);
    for (const phrase of ["not carried", "excluded from recall", "Nothing is deleted", "v4 ids", ...NOT_CARRIED]) expect(text).toContain(phrase);
    expect(calls).toEqual([]);
  });

  test("it carries A9's hint: an over-256-KiB body is refused as HTTP 413 before any tool runs, publish it over HTTP", async () => {
    configureKnowledgeAccess(configured);
    const text = toolText(await call(true, "ro", "____IMPORTANT"));
    for (const phrase of ["256 KiB", "HTTP 413", "POST /api/knowledge/<bank>/publishRevision", "1 MiB"]) expect(text).toContain(phrase);
  });
});

describe("the index profile uses embed.ts's own EMBEDDING_MODEL rule", () => {
  test("unset is all-minilm; any set value, even blank or padded, is used as-is (embed.ts and migrate-py use a plain default)", async () => {
    const { indexProfile } = await import("../src/knowledge/transport.indexProfile");
    for (const value of [undefined, "", " all-minilm ", "nomic-embed-text"]) {
      const env = value === undefined ? {} : { EMBEDDING_MODEL: value };
      expect(indexProfile(env).embedding_profile.name).toBe(value ?? "all-minilm");
    }
  });
});

describe("defect 6 and D1", () => {
  test("mcp/index.ts no longer exports the dead duplicate action map", () => {
    expect("toolAction" in mcpModule).toBe(false);
  });

  test("legacy node ids match the Python-computed known answers byte for byte (D1)", async () => {
    const { legacyNodeId } = await import("../src/mcp/legacy-v3/ids.legacyNodeId");
    // python3: base64.urlsafe_b64encode(sha256(("arra-legacy-node/v1\n"+ws+"\n"+id).encode())).rstrip("=")[:21]
    expect(legacyNodeId("bank-a", "m_lq3k9x2_abc123")).toBe("kBExBu_pgF8CSTrjSzC_I");
    expect(legacyNodeId("bank-a", "learning_2026-03-04_apfs")).toBe("zKcwQHLUSYW9ljudpIMcF");
    expect(legacyNodeId("bank-b", "m_lq3k9x2_abc123")).toBe("pGHmzX0AfJRh2y01RrHv7");
    expect(legacyNodeId("ไทย", "หลงลืม")).toBe("rcF_igH1t5czE1F0pXnPz");
  });

  test("the resolver refuses an id that is both a direct and a derived node, never guessing", async () => {
    const { resolveNodeId } = await import("../src/mcp/legacy-v3/ids.resolveNodeId");
    const { legacyNodeId } = await import("../src/mcp/legacy-v3/ids.legacyNodeId");
    const direct = "abcdefghijklmnopqrstu";
    const heads = (present: string[]) => async (_m: string, p: Record<string, unknown>) =>
      present.includes(p.node_id as string) ? { node_id: p.node_id, revision_id: "r".repeat(21) } : null;
    expect((await resolveNodeId(heads([direct]), BANK, direct, "oracle_read"))?.node_id).toBe(direct);
    expect((await resolveNodeId(heads([legacyNodeId(BANK, direct)]), BANK, direct, "oracle_read"))?.node_id).toBe(legacyNodeId(BANK, direct));
    await expect(resolveNodeId(heads([direct, legacyNodeId(BANK, direct)]), BANK, direct, "oracle_read")).rejects.toMatchObject({ code: "semantic_refusal" });
    expect(await resolveNodeId(heads([]), BANK, direct, "oracle_read")).toBeNull();
    await expect(resolveNodeId(heads([]), BANK, "3264052e-e8d4-4a64-a255-8e72b0e0979b", "oracle_read")).rejects.toMatchObject({ code: "legacy_id_unknown" });
  });
});
