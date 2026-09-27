/**
 * #32 / #31 peer representation and node/revision-grounded context (Nat
 * 2026-09-28 NAT-DECISIONS D3b; AC-MATRIX slices 11 then 10; DESIGN.md §12).
 *
 * Against a real gated dataset (`fixtures/representation-v1/seed-child.ts`),
 * read through the production registry entries, HTTP and MCP:
 *
 *   1. getContext selects eligible CURRENT `conclusion` revisions: superseded,
 *      retired, non-conclusion, cross-workspace and protected ones never
 *      appear; each carries node/revision ids, text, perspective and sources.
 *   2. observer/subject narrow the selection and never widen permissions:
 *      a non-member stays refused, a protected conclusion stays hidden, an
 *      unknown peer name fails closed with `invalid_reference`.
 *   3. getRepresentation is the scoped `observer -> subject` view, bound by
 *      the same R3 read authority as listMessages; never merges observers or
 *      workspaces.
 *   4. context and representation reads write nothing (table versions and
 *      row counts unchanged) and call no model (the model throws).
 *   5. answerChat accepts observer/about, cites node/revision ids and
 *      message ids, and its prompt includes the conclusions.
 *   6. Slice 10: a budget block that names an ESTIMATE and its heuristic,
 *      reports truncation, and a freshness block with watermarks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";
import { createApp } from "../src/app";
import { createOperationService } from "../src/auth/service";
import { KNOWLEDGE_METHODS } from "../src/knowledge/registry";
import { createKnowledgeAccess, type KnowledgeAccess } from "../src/knowledge/transport";
import { configureKnowledgeAccess, createMcpAdapter } from "../src/mcp";
import type { ChatModelInput } from "../src/publication/chat";
import { TARGET_TABLES } from "../src/publication/storage";
import { createContextFixture } from "./helpers/context-fixture";
import { runGated } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const SEED = new URL("./fixtures/representation-v1/seed-child.ts", import.meta.url).pathname;
const TIMEOUT_MS = testTimeout(240_000);
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const TOKEN = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const ORIGIN = "http://127.0.0.1:3939";

const MEMBER = { operator: false, peers: null };
const OPERATOR = { operator: true, peers: null };

let cleanup: (() => Promise<void>) | null = null;
let policyDir: string | null = null;
let root = "";
let seeded: { nodes: Record<string, string>; revisions: Record<string, string> };
let access: KnowledgeAccess;
let throwingAccess: KnowledgeAccess;
let modelInputs: ChatModelInput[] = [];
let modelCalls = 0;
let app: { handle: (request: Request) => Promise<Response> };

beforeAll(async () => {
  const fixture = await createContextFixture([ALPHA, BETA]);
  cleanup = fixture.cleanup;
  root = fixture.datasetRoot;
  const run = await runGated(root, SEED, [root]);
  const line = run.stdout.trim().split("\n").pop() ?? "";
  if (run.code !== 0 || !line.includes('"ok":true')) {
    throw new Error(`seed child failed (${run.code}): ${line} ${run.stderr.slice(-1500)}`);
  }
  seeded = JSON.parse(line);

  const settings = { provider: "stub", model: "stub", max_output_tokens: 16, timeout_ms: 1000 };
  access = createKnowledgeAccess({
    datasetRoot: root,
    chat: {
      settings,
      model: async (input: ChatModelInput) => {
        modelInputs.push(input);
        return "stub answer";
      },
    },
  }) as KnowledgeAccess;
  throwingAccess = createKnowledgeAccess({
    datasetRoot: root,
    chat: {
      settings,
      model: async () => {
        modelCalls += 1;
        throw new Error("a read must never call the model");
      },
    },
  }) as KnowledgeAccess;

  policyDir = await mkdtemp(join(tmpdir(), "arra-v4-peer-rep-"));
  const policyPath = join(policyDir, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        { id: "reader", disabled: false, workspaces: [{ name: ALPHA, actions: ["content:read"] }], global_actions: [] },
      ],
      credentials: [
        {
          id: "cred-reader",
          principal_id: "reader",
          sha256: createHash("sha256").update(TOKEN, "ascii").digest("hex"),
          not_before: "2026-01-01T00:00:00.000Z",
          expires_at: "2030-01-01T00:00:00.000Z",
          revoked: false,
        },
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
  const service = createOperationService({ policyPath }, { logCall: async () => {} } as never);
  app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });
}, TIMEOUT_MS);

afterAll(async () => {
  configureKnowledgeAccess(null);
  if (policyDir !== null) await rm(policyDir, { recursive: true, force: true });
  if (cleanup !== null) await cleanup();
});

type Attempt = { ok: true; value: any } | { ok: false; code: string; path: string };

/** The production registry entry, on the production reader bundle. */
async function call(method: string, body: unknown, authority = MEMBER, via = access): Promise<Attempt> {
  const entry = KNOWLEDGE_METHODS[method];
  if (entry === undefined) return { ok: false, code: "no_such_method", path: "" };
  try {
    const bundle = await via.getBundle(entry.action);
    return { ok: true, value: await entry.call(bundle, new TextEncoder().encode(JSON.stringify(body)), authority) };
  } catch (error) {
    const e = error as { code?: string; path?: string };
    return { ok: false, code: String(e.code), path: String(e.path) };
  }
}
const ok = (attempt: Attempt): any => {
  if (!attempt.ok) throw new Error(`expected ok, got ${attempt.code} at ${attempt.path}`);
  return attempt.value;
};

const context = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  peer_name: "neo",
  session_name: "main",
  max_items: 10,
  ...overrides,
});
const representation = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  requester_peer_name: "neo",
  observer_peer_name: "neo",
  subject_peer_name: "nat",
  max_items: 10,
  ...overrides,
});
const revisionsOf = (result: any): string[] => (result.conclusions as any[]).map((c) => c.revision_id).sort();
const rev = (...labels: string[]) => labels.map((label) => seeded.revisions[label]!).sort();

/** Every table's version and row count, straight from LanceDB. */
async function snapshot(): Promise<Record<string, [number, number]>> {
  const db = await connect(root);
  const out: Record<string, [number, number]> = {};
  for (const name of TARGET_TABLES) {
    const table = await db.openTable(name);
    out[name] = [await table.version(), await table.countRows()];
  }
  return out;
}

describe("getContext selects eligible current conclusions (#32 TODO 2, rev.2 get_context)", () => {
  test("current conclusions only: superseded, retired, notes, protected and other workspaces never appear", async () => {
    const result = ok(await call("getContext", context()));
    expect(revisionsOf(result)).toEqual(rev("C1", "C2", "C5", "C8"));
    const text = JSON.stringify(result);
    for (const marker of ["OLD-VIEW", "RETIRED-VIEW", "NOTE-ONLY", "SECRET", "BETA-ONLY", "prmsgsecret"]) {
      expect(text.includes(marker)).toBe(false);
    }
    // The protected conclusion and the protected source are a coarse flag,
    // never a count or an id.
    expect(result.coverage).toBe("partial");
    expect(result.conclusions_coverage).toEqual({ complete: false });
    expect(result.summary).toBeNull();
  });

  test("each conclusion carries node/revision ids, text, perspective and source handles; Thai round-trips", async () => {
    const result = ok(await call("getContext", context()));
    const c1 = (result.conclusions as any[]).find((c) => c.revision_id === seeded.revisions.C1);
    expect(c1).toMatchObject({
      node_id: seeded.nodes.C1,
      revision_id: seeded.revisions.C1,
      title: "นัทชอบกาแฟ",
      text: "นัทชอบกาแฟดำทุกเช้า (nat likes black coffee)",
      author_peer_name: "neo",
      observer_peer_name: "neo",
      subject_peer_name: "nat",
      sources_incomplete: false,
    });
    expect(c1.sources).toEqual([
      {
        relation: "supports",
        target_kind: "message",
        target: { session_name: "main", message_public_id: "prmsgmain00000000000" + "0" },
        capture_status: "locator_only",
      },
    ]);
    const c8 = (result.conclusions as any[]).find((c) => c.revision_id === seeded.revisions.C8);
    expect(c8.sources).toEqual([]);
    expect(c8.sources_incomplete).toBe(true);
  });

  test("observer/subject narrow the selection", async () => {
    expect(revisionsOf(ok(await call("getContext", context({ observer_peer_name: "neo", subject_peer_name: "nat" }))))).toEqual(
      rev("C1", "C5"),
    );
    expect(revisionsOf(ok(await call("getContext", context({ observer_peer_name: "claude" }))))).toEqual(rev("C2"));
    expect(revisionsOf(ok(await call("getContext", context({ subject_peer_name: "claude" }))))).toEqual(rev("C8"));
  });

  test("perspective never widens permissions", async () => {
    // neo asking as observer neo still cannot see the conclusion drawn in `private`.
    const narrowed = ok(await call("getContext", context({ observer_peer_name: "neo", subject_peer_name: "nat" })));
    expect(JSON.stringify(narrowed).includes("SECRET")).toBe(false);
    // A non-member of `main` stays refused whatever perspective it names.
    const outsider = await call("getContext", context({ peer_name: "outsider", observer_peer_name: "neo" }));
    expect(outsider).toEqual({ ok: false, code: "invalid_reference", path: "/peer_name" });
    // Unknown peer names fail closed.
    expect(await call("getContext", context({ observer_peer_name: "ghost" }))).toEqual({
      ok: false,
      code: "invalid_reference",
      path: "/observer_peer_name",
    });
    expect(await call("getContext", context({ subject_peer_name: "ghost" }))).toEqual({
      ok: false,
      code: "invalid_reference",
      path: "/subject_peer_name",
    });
    // Another workspace with the same peer names sees only its own conclusion.
    const beta = ok(await call("getContext", context({ workspace_name: BETA, observer_peer_name: "neo" })));
    expect(revisionsOf(beta)).toEqual(rev("B1"));
  });

  test("slice 10: budget names an estimate and its heuristic; truncation is reported", async () => {
    const full = ok(await call("getContext", context()));
    expect(full.budget.tokenizer).toBeNull();
    expect(full.budget.token_count_kind).toBe("estimate");
    expect(full.budget.estimate_heuristic).toBe("ceil(utf8_bytes/4)");
    expect(full.budget.estimated_tokens).toBeGreaterThan(0);
    expect(full.budget.truncated).toBe(false);
    const cut = ok(await call("getContext", context({ max_items: 1 })));
    expect(cut.conclusions.length).toBe(1);
    expect(cut.budget.truncated).toBe(true);
    expect(cut.coverage).toBe("partial");
  });

  test("slice 10: freshness reports assembled_at and source watermarks or 'unknown'", async () => {
    const result = ok(await call("getContext", context()));
    expect(result.freshness.assembled_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    for (const table of ["messages", "nodes", "node_revisions", "supersede_log"]) {
      expect(typeof result.freshness.source_watermarks[table]).toBe("number");
    }
    expect(result.freshness.index_watermark).toBe("unknown");
  });
});

describe("getRepresentation: observer -> subject, scoped (#32 2026-09-20 comment, #31 rev.2)", () => {
  test("a member sees the current conclusions of that one perspective", async () => {
    const result = ok(await call("getRepresentation", representation()));
    expect(result.observer_peer_name).toBe("neo");
    expect(result.subject_peer_name).toBe("nat");
    expect(revisionsOf(result)).toEqual(rev("C1", "C5"));
    expect(result.summary).toBeNull();
    expect(result.coverage).toBe("partial"); // C3 is protected: coarse flag only
    expect(JSON.stringify(result).includes("SECRET")).toBe(false);
  });

  test("never merges observers or workspaces", async () => {
    expect(revisionsOf(ok(await call("getRepresentation", representation({ observer_peer_name: "claude" }))))).toEqual(rev("C2"));
    const beta = ok(await call("getRepresentation", representation({ workspace_name: BETA })));
    expect(revisionsOf(beta)).toEqual(rev("B1"));
    expect(JSON.stringify(ok(await call("getRepresentation", representation()))).includes("BETA-ONLY")).toBe(false);
  });

  test("the operator view sees protected conclusions; no requester without it is forbidden", async () => {
    const operator = ok(await call("getRepresentation", representation({ requester_peer_name: null }), OPERATOR));
    expect(revisionsOf(operator)).toEqual(rev("C1", "C3", "C5"));
    expect(operator.coverage).toBe("full");
    expect(await call("getRepresentation", representation({ requester_peer_name: null }))).toEqual({
      ok: false,
      code: "forbidden",
      path: "/requester_peer_name",
    });
    const boundToNat = { operator: false, peers: ["nat"] } as never;
    expect(await call("getRepresentation", representation({ requester_peer_name: "neo" }), boundToNat)).toEqual({
      ok: false,
      code: "forbidden",
      path: "/requester_peer_name",
    });
  });

  test("unknown peers fail closed", async () => {
    expect(await call("getRepresentation", representation({ subject_peer_name: "ghost" }))).toEqual({
      ok: false,
      code: "invalid_reference",
      path: "/subject_peer_name",
    });
    expect(await call("getRepresentation", representation({ requester_peer_name: "ghost" }))).toEqual({
      ok: false,
      code: "invalid_reference",
      path: "/requester_peer_name",
    });
  });
});

describe("context and representation reads are model-free and write-free (#32 rev.2, 2026-09-20 comment)", () => {
  test("no table version or row count moves; the throwing model is never called", async () => {
    const before = await snapshot();
    modelCalls = 0;
    ok(await call("getContext", context({ observer_peer_name: "neo" }), MEMBER, throwingAccess));
    ok(await call("getRepresentation", representation(), MEMBER, throwingAccess));
    ok(await call("getRepresentation", representation({ requester_peer_name: null }), OPERATOR, throwingAccess));
    expect(modelCalls).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});

describe("answerChat: observer/about, node/revision citations (#32 TODO 1-2)", () => {
  test("the prompt carries the perspective's conclusions and the answer cites their ids", async () => {
    modelInputs = [];
    const result = ok(
      await call("answerChat", {
        ...context({ observer_peer_name: "neo", subject_peer_name: "nat" }),
        question: "What does nat drink?",
      }),
    );
    expect(modelInputs.length).toBe(1);
    const prompt = modelInputs[0]!.context_text;
    expect(prompt).toContain("นัทชอบกาแฟดำทุกเช้า");
    expect(prompt).toContain("NEW-VIEW");
    expect(prompt).not.toContain("SECRET");
    expect(prompt).not.toContain("OLD-VIEW");
    expect(prompt).not.toContain("claude thinks");
    expect(result.items_used.length).toBeGreaterThan(0);
    // Most recently updated first: C5 was published after C1.
    expect(result.conclusions_used).toEqual([
      { node_id: seeded.nodes.C5, revision_id: seeded.revisions.C5 },
      { node_id: seeded.nodes.C1, revision_id: seeded.revisions.C1 },
    ]);
    expect(result.budget.token_count_kind).toBe("estimate");
    expect(typeof result.freshness.assembled_at).toBe("string");
  });
});

describe("transports: getRepresentation is a registry method on HTTP and MCP (#31)", () => {
  const headers = { host: "127.0.0.1:3939", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  test("HTTP POST /api/knowledge/:bank/getRepresentation", async () => {
    const res = await app.handle(
      new Request(`${ORIGIN}/api/knowledge/${ALPHA}/getRepresentation`, {
        method: "POST",
        headers,
        body: JSON.stringify(representation()),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(revisionsOf(body)).toEqual(rev("C1", "C5"));
    expect(JSON.stringify(body)).toContain("นัทชอบกาแฟดำทุกเช้า"); // Thai survives the wire
  });

  test("MCP kb_getRepresentation is listed and answers the same", async () => {
    configureKnowledgeAccess(access);
    const rpc = async (method: string, params: unknown) =>
      (await (
        await app.handle(
          new Request(`${ORIGIN}/mcp/${ALPHA}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
        )
      ).json()) as any;
    const listed = await rpc("tools/list", {});
    expect((listed.result.tools as { name: string }[]).some((tool) => tool.name === "kb_getRepresentation")).toBe(true);
    const called = await rpc("tools/call", { name: "kb_getRepresentation", arguments: { payload: representation() } });
    expect(called.result.isError).not.toBe(true);
    expect(revisionsOf(JSON.parse(called.result.content[0].text))).toEqual(rev("C1", "C5"));
  });
});
