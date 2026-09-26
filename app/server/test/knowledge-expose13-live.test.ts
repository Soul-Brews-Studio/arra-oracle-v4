// #31 overnight R7/R8 (issues #28, #29, #30, #31): real-dataset, real-gate
// proof that the 13 previously-unreachable methods work end to end, over
// BOTH HTTP and MCP, against a REAL target-19 LanceDB dataset created by the
// accepted Python exporter and written inside the REAL writer gate (fd 42) --
// no facade is called directly, no store is faked. See
// `test/fixtures/transport-v1/expose13/child.ts` for the process that
// actually drives the wire.
//
// Round trips, per the task brief:
//   createTrace -> getTrace -> listTraceHits
//   createSessionLink -> listSessionLinks
//   retireNode / supersedeNode -> listLifecycleHistory -> getRecallEligibility
//   indexRevisionChunks -> listSearchChunks -> writeChunkEmbedding -> reconcileSearchChunks
// Every write is exercised over HTTP AND replayed byte-identically over MCP
// (this kernel's own idempotency mechanism: a replay of an already-written
// create/lifecycle event returns `already_satisfied`/`idempotent` rather
// than writing twice), which proves both transports dispatch to the exact
// same registry entry against the exact same dataset. Search-chunk indexing
// uses two DIFFERENT nodes (one indexed over HTTP, one over MCP) since a
// `pending` chunk cannot be re-embedded, so an idempotent replay is not the
// right proof there.
//
// Also covers the brief's authorization requirement on a live dataset: a
// content:read-only principal is refused on writes, and a principal granted
// only on a different workspace is refused on everything -- both already
// proved exhaustively (all 13 methods) at the fake-bundle level in
// `knowledge-expose13-transport.test.ts`; this file adds a same-shape spot
// check against the real writer gate and real admission, not a full repeat.

import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { activeEmbeddingProfileId } from "../src/publication/search-chunk";

const TEST_DIR = import.meta.dir;
const CHILD = join(TEST_DIR, "fixtures", "transport-v1", "expose13", "child.ts");
const TEST_TIMEOUT_MS = 120_000;

const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/transport-v1/expose13/child.ts");
const PENDING = MISSING.length > 0;

test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});

const runIt = PENDING ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const NODE_A = pad("expose13nodeA");
const NODE_B = pad("expose13nodeB");
const NODE_C = pad("expose13nodeC");
const NODE_X = pad("expose13nodeX");
const NODE_Y = pad("expose13nodeY");
const TRACE_1 = pad("expose13trace1");
const TRACE_2 = pad("expose13trace2");
const LINK_1 = pad("expose13link1");
const SESSION_1_ID = pad("expose13sess1");
const SESSION_2_ID = pad("expose13sess2");
const SESSION_1_NAME = "expose13-session-a";
const SESSION_2_NAME = "expose13-session-b";

const CHUNKER_VERSION = "chunker/v1";
// #30 R7: `indexRevisionChunks`/`listSearchChunks` now refuse any
// `embedding_profile` name outside the closed registry.
const EMBEDDING_PROFILE_NAME = activeEmbeddingProfileId();

type Step = {
  label: string;
  transport: "http" | "mcp";
  token: "write" | "read" | "other";
  bank: "alpha" | "beta";
  method: string;
  body: unknown;
  /** See `child.ts`: captures a value out of this step's own response for a
   *  later step's body to reference as the literal string `"@name"`. Needed
   *  ONLY for a revision id (writer-assigned, `randomNanoid21`, never
   *  caller-chosen like every node/trace/session/link id in this file) and
   *  for a derived chunk id (a sha256 of that revision id, so it inherits
   *  the same can't-precompute constraint). */
  capture?: { name: string; path: (string | number)[] };
};

function buildSteps(seededAlpha: Fixture["workspaces"][string]): Step[] {
  const s = (
    label: string,
    transport: Step["transport"],
    token: Step["token"],
    method: string,
    body: unknown,
    options: { bank?: Step["bank"]; capture?: Step["capture"] } = {},
  ): Step => ({ label, transport, token, bank: options.bank ?? "alpha", method, body, capture: options.capture });

  const hit = () => ({
    kind: "url",
    target: { url: "https://example.com/expose13" },
    ref: "citation-1",
    line_start: null,
    line_end: null,
    excerpt: null,
    content_hash: null,
    captured_at: null,
    note: null,
  });

  const traceRequest = (id: string, overrides: Record<string, unknown> = {}) => ({
    workspace_name: ALPHA,
    id,
    name: "expose13-trace",
    session_name: null,
    peer_name: null,
    query: "find the bug",
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
    hits: [hit()],
    ...overrides,
  });

  const linkRequest = () => ({
    id: LINK_1,
    workspace_name: ALPHA,
    from_session_name: SESSION_1_NAME,
    to_session_name: SESSION_2_NAME,
    relation: "continues",
    evidence_ref: null,
    created_by_peer_name: null,
  });

  // `@REV_A` / `@REV_B` / `@REV_C` are substituted by the child from the
  // `pub_A`/`pub_B`/`pub_C` steps' own captured `revision_id` -- see the
  // `Step["capture"]` doc comment above.
  const supersedeRequest = () => ({
    workspace_name: ALPHA,
    node_id: NODE_A,
    expected_revision_id: "@REV_A",
    new_node_id: NODE_B,
    new_revision_id: "@REV_B",
    reason: "superseded by a newer note",
    peer_name: null,
    operation_id: "expose13-op-supersede-1",
  });

  const retireRequest = () => ({
    workspace_name: ALPHA,
    node_id: NODE_C,
    expected_revision_id: "@REV_C",
    reason: "no longer needed",
    peer_name: null,
    operation_id: "expose13-op-retire-1",
  });

  const indexRequest = (nodeId: string, revisionId: string) => ({
    workspace_name: ALPHA,
    node_id: nodeId,
    revision_id: revisionId,
    chunker_version: CHUNKER_VERSION,
    embedding_profile: { name: EMBEDDING_PROFILE_NAME, dims: 384 },
  });

  const listChunksRequest = (revisionId: string) => ({
    workspace_name: ALPHA,
    revision_id: revisionId,
    chunker_version: CHUNKER_VERSION,
    embedding_profile: EMBEDDING_PROFILE_NAME,
  });

  const embedRequest = (id: string, fill: number) => ({
    workspace_name: ALPHA,
    id,
    embedding: Array.from({ length: 384 }, () => fill),
  });

  return [
    // ── setup (existing exposed methods; not part of this slice) ──────────
    s(
      "pub_A",
      "http",
      "write",
      "publishRevision",
      { operation_id: "expose13-op-a1", content: revisionEnvelope(ALPHA, seededAlpha, NODE_A, { title: "node A" }) },
      { capture: { name: "REV_A", path: ["revision_id"] } },
    ),
    s(
      "pub_B",
      "http",
      "write",
      "publishRevision",
      { operation_id: "expose13-op-b1", content: revisionEnvelope(ALPHA, seededAlpha, NODE_B, { title: "node B" }) },
      { capture: { name: "REV_B", path: ["revision_id"] } },
    ),
    s(
      "pub_C",
      "http",
      "write",
      "publishRevision",
      { operation_id: "expose13-op-c1", content: revisionEnvelope(ALPHA, seededAlpha, NODE_C, { title: "node C" }) },
      { capture: { name: "REV_C", path: ["revision_id"] } },
    ),
    s(
      "pub_X",
      "http",
      "write",
      "publishRevision",
      {
        operation_id: "expose13-op-x1",
        content: revisionEnvelope(ALPHA, seededAlpha, NODE_X, { title: "chunk source X", body: "chunk source body X" }),
      },
      { capture: { name: "REV_X", path: ["revision_id"] } },
    ),
    s(
      "pub_Y",
      "http",
      "write",
      "publishRevision",
      {
        operation_id: "expose13-op-y1",
        content: revisionEnvelope(ALPHA, seededAlpha, NODE_Y, { title: "chunk source Y", body: "chunk source body Y" }),
      },
      { capture: { name: "REV_Y", path: ["revision_id"] } },
    ),
    s("reg_s1", "http", "write", "registerSession", {
      workspace_name: ALPHA,
      session_id: SESSION_1_ID,
      name: SESSION_1_NAME,
    }),
    s("reg_s2", "http", "write", "registerSession", {
      workspace_name: ALPHA,
      session_id: SESSION_2_ID,
      name: SESSION_2_NAME,
    }),

    // ── #28 trace: createTrace -> getTrace -> listTraceHits ────────────────
    s("trace_create_http", "http", "write", "createTrace", traceRequest(TRACE_1)),
    s("trace_create_mcp_replay", "mcp", "write", "createTrace", traceRequest(TRACE_1)),
    s("trace_get_http", "http", "read", "getTrace", { workspace_name: ALPHA, id: TRACE_1 }),
    s("trace_get_mcp", "mcp", "read", "getTrace", { workspace_name: ALPHA, id: TRACE_1 }),
    s("trace_hits_http", "http", "read", "listTraceHits", {
      workspace_name: ALPHA,
      trace_id: TRACE_1,
      after_position: null,
      limit: 10,
    }),
    s("trace_hits_mcp", "mcp", "read", "listTraceHits", {
      workspace_name: ALPHA,
      trace_id: TRACE_1,
      after_position: null,
      limit: 10,
    }),

    // ── #28 session links: createSessionLink -> listSessionLinks ──────────
    s("link_create_http", "http", "write", "createSessionLink", linkRequest()),
    s("link_create_mcp_replay", "mcp", "write", "createSessionLink", linkRequest()),
    s("link_list_from_http", "http", "read", "listSessionLinks", {
      workspace_name: ALPHA,
      session_name: SESSION_1_NAME,
      direction: "from",
      cursor: null,
      limit: 10,
    }),
    s("link_list_to_mcp", "mcp", "read", "listSessionLinks", {
      workspace_name: ALPHA,
      session_name: SESSION_2_NAME,
      direction: "to",
      cursor: null,
      limit: 10,
    }),

    // ── #29 lifecycle: retireNode/supersedeNode -> listLifecycleHistory -> getRecallEligibility ──
    s("supersede_http", "http", "write", "supersedeNode", supersedeRequest()),
    s("supersede_mcp_replay", "mcp", "write", "supersedeNode", supersedeRequest()),
    s("retire_http", "http", "write", "retireNode", retireRequest()),
    s("retire_mcp_replay", "mcp", "write", "retireNode", retireRequest()),
    s("history_A_http", "http", "read", "listLifecycleHistory", {
      workspace_name: ALPHA,
      node_id: NODE_A,
      after_event_id: null,
      limit: 10,
    }),
    s("history_C_mcp", "mcp", "read", "listLifecycleHistory", {
      workspace_name: ALPHA,
      node_id: NODE_C,
      after_event_id: null,
      limit: 10,
    }),
    s("eligibility_A_http", "http", "read", "getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_A }),
    s("eligibility_C_mcp", "mcp", "read", "getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_C }),

    // ── #30 search chunks: indexRevisionChunks -> listSearchChunks -> writeChunkEmbedding -> reconcileSearchChunks ──
    // `@REV_X` / `@REV_Y` come from `pub_X`/`pub_Y` above; each index step
    // captures its own single deterministic-id chunk row's `id` in turn, for
    // `embed_X_http`/`embed_Y_mcp` to reference as `@CHUNK_X_ID`/`@CHUNK_Y_ID`.
    s("index_X_http", "http", "write", "indexRevisionChunks", indexRequest(NODE_X, "@REV_X"), {
      capture: { name: "CHUNK_X_ID", path: ["rows", 0, "id"] },
    }),
    s("index_Y_mcp", "mcp", "write", "indexRevisionChunks", indexRequest(NODE_Y, "@REV_Y"), {
      capture: { name: "CHUNK_Y_ID", path: ["rows", 0, "id"] },
    }),
    s("list_X_http", "http", "read", "listSearchChunks", listChunksRequest("@REV_X")),
    s("list_Y_mcp", "mcp", "read", "listSearchChunks", listChunksRequest("@REV_Y")),
    s("embed_X_http", "http", "write", "writeChunkEmbedding", embedRequest("@CHUNK_X_ID", 0.5)),
    s("embed_Y_mcp", "mcp", "write", "writeChunkEmbedding", embedRequest("@CHUNK_Y_ID", 0.25)),
    s("reconcile_http", "http", "write", "reconcileSearchChunks", { workspace_name: ALPHA, limit: 50 }),
    s("reconcile_mcp", "mcp", "write", "reconcileSearchChunks", { workspace_name: ALPHA, limit: 50 }),

    // ── authorization spot checks on the real gate ─────────────────────────
    s("authz_read_refused_http", "http", "read", "createTrace", traceRequest(TRACE_2)),
    s("authz_read_refused_mcp", "mcp", "read", "createTrace", traceRequest(TRACE_2)),
    s(
      "authz_other_refused_read_http",
      "http",
      "other",
      "getRecallEligibility",
      { workspace_name: ALPHA, node_id: NODE_A },
    ),
    s(
      "authz_other_refused_read_mcp",
      "mcp",
      "other",
      "getRecallEligibility",
      { workspace_name: ALPHA, node_id: NODE_A },
    ),
    s("authz_other_refused_write_http", "http", "other", "supersedeNode", supersedeRequest()),
  ];
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  const failures: string[] = [];
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch((error: unknown) => failures.push(String(error)));
  }
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(" | ")}`);
});

runIt(
  "all 13 previously-404 methods round-trip over BOTH HTTP and MCP against a real writer-gated dataset",
  async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const seededAlpha = fixture.workspaces[ALPHA]!;

    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-expose13-live-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const steps = buildSteps(seededAlpha);
    const payload = { banks: { alpha: ALPHA, beta: BETA }, steps };
    const result = await runGated(fixture.datasetRoot, CHILD, [
      fixture.datasetRoot,
      workDir,
      JSON.stringify(payload),
    ]);
    if (result.code !== 0) {
      throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}\n${result.stdout.slice(0, 2000)}`);
    }
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
    const out: Record<string, any> = JSON.parse(line);

    // ── setup landed ────────────────────────────────────────────────────
    for (const label of ["pub_A", "pub_B", "pub_C", "pub_X", "pub_Y", "reg_s1", "reg_s2"]) {
      expect(out[label], JSON.stringify(out[label])).toMatchObject({ status: 200 });
    }

    // Revision ids the writer assigned (`randomNanoid21`) -- not knowable
    // ahead of the run, which is exactly why `child.ts`'s `capture`/`"@name"`
    // substitution exists (see the `Step["capture"]` doc comment above).
    const revA = out.pub_A.body.revision_id as string;
    const revX = out.pub_X.body.revision_id as string;
    const revY = out.pub_Y.body.revision_id as string;
    const chunkXId = out.index_X_http.body.rows[0].id as string;
    const chunkYId = out.index_Y_mcp.value.rows[0].id as string;

    // ── trace ───────────────────────────────────────────────────────────
    expect(out.trace_create_http.status, JSON.stringify(out.trace_create_http)).toBe(200);
    expect(out.trace_create_http.body.outcome).toBe("created");
    expect(out.trace_create_http.body.hits).toHaveLength(1);

    expect(out.trace_create_mcp_replay.ok, JSON.stringify(out.trace_create_mcp_replay)).toBe(true);
    expect(out.trace_create_mcp_replay.value.outcome).toBe("already_satisfied");

    expect(out.trace_get_http.status).toBe(200);
    expect(out.trace_get_http.body.name).toBe("expose13-trace");
    expect(out.trace_get_mcp.ok).toBe(true);
    expect(out.trace_get_mcp.value.name).toBe("expose13-trace");

    expect(out.trace_hits_http.status).toBe(200);
    expect(out.trace_hits_http.body.rows).toHaveLength(1);
    expect(out.trace_hits_mcp.ok).toBe(true);
    expect(out.trace_hits_mcp.value.rows).toHaveLength(1);

    // ── session links ───────────────────────────────────────────────────
    expect(out.link_create_http.status, JSON.stringify(out.link_create_http)).toBe(200);
    expect(out.link_create_http.body.outcome).toBe("created");
    expect(out.link_create_mcp_replay.ok, JSON.stringify(out.link_create_mcp_replay)).toBe(true);
    expect(out.link_create_mcp_replay.value.outcome).toBe("already_satisfied");

    expect(out.link_list_from_http.status).toBe(200);
    expect(out.link_list_from_http.body.rows).toHaveLength(1);
    expect(out.link_list_from_http.body.rows[0].to_session_name).toBe(SESSION_2_NAME);
    expect(out.link_list_to_mcp.ok).toBe(true);
    expect(out.link_list_to_mcp.value.rows).toHaveLength(1);
    expect(out.link_list_to_mcp.value.rows[0].from_session_name).toBe(SESSION_1_NAME);

    // ── lifecycle ───────────────────────────────────────────────────────
    expect(out.supersede_http.status, JSON.stringify(out.supersede_http)).toBe(200);
    expect(out.supersede_http.body.outcome).toBe("accepted");
    expect(out.supersede_mcp_replay.ok, JSON.stringify(out.supersede_mcp_replay)).toBe(true);
    expect(out.supersede_mcp_replay.value.outcome).toBe("idempotent");

    expect(out.retire_http.status, JSON.stringify(out.retire_http)).toBe(200);
    expect(out.retire_http.body.outcome).toBe("accepted");
    expect(out.retire_mcp_replay.ok, JSON.stringify(out.retire_mcp_replay)).toBe(true);
    expect(out.retire_mcp_replay.value.outcome).toBe("idempotent");

    expect(out.history_A_http.status).toBe(200);
    expect(out.history_A_http.body.rows).toHaveLength(1);
    expect(out.history_C_mcp.ok).toBe(true);
    expect(out.history_C_mcp.value.rows).toHaveLength(1);

    expect(out.eligibility_A_http.status).toBe(200);
    expect(out.eligibility_A_http.body.eligible).toBe(false);
    expect(out.eligibility_C_mcp.ok).toBe(true);
    expect(out.eligibility_C_mcp.value.eligible).toBe(false);

    // ── search chunks ───────────────────────────────────────────────────
    expect(out.index_X_http.status, JSON.stringify(out.index_X_http)).toBe(200);
    expect(out.index_X_http.body.outcome).toBe("indexed");
    expect(out.index_X_http.body.rows).toHaveLength(1);
    expect(out.index_X_http.body.rows[0].id).toBe(chunkXId);

    expect(out.index_Y_mcp.ok, JSON.stringify(out.index_Y_mcp)).toBe(true);
    expect(out.index_Y_mcp.value.outcome).toBe("indexed");
    expect(out.index_Y_mcp.value.rows[0].id).toBe(chunkYId);

    expect(out.list_X_http.status).toBe(200);
    expect(out.list_X_http.body).toHaveLength(1);
    expect(out.list_X_http.body[0].id).toBe(chunkXId);
    expect(out.list_X_http.body[0].status).toBe("pending");

    expect(out.list_Y_mcp.ok).toBe(true);
    expect(out.list_Y_mcp.value).toHaveLength(1);
    expect(out.list_Y_mcp.value[0].id).toBe(chunkYId);

    expect(out.embed_X_http.status, JSON.stringify(out.embed_X_http)).toBe(200);
    expect(out.embed_X_http.body.outcome).toBe("embedded");
    expect(out.embed_X_http.body.row.status).toBe("ready");

    expect(out.embed_Y_mcp.ok, JSON.stringify(out.embed_Y_mcp)).toBe(true);
    expect(out.embed_Y_mcp.value.outcome).toBe("embedded");
    expect(out.embed_Y_mcp.value.row.status).toBe("ready");

    expect(out.reconcile_http.status, JSON.stringify(out.reconcile_http)).toBe(200);
    const missingHttp = out.reconcile_http.body.missing_revisions as { revision_id: string }[];
    expect(missingHttp.some((m) => m.revision_id === revX)).toBe(false);
    expect(missingHttp.some((m) => m.revision_id === revY)).toBe(false);
    // NODE_A was superseded above (`supersede_http`), so #30 overnight R7's
    // reconcile treats it as INELIGIBLE (the same `supersede_log` check
    // `getRecallEligibility` uses) and excludes it from missing/incomplete
    // accounting entirely -- a superseded node's content is not expected to
    // be currently indexed, so it is not a gap to report. This reconcile
    // call still genuinely visited and distinguished real rows: it counts
    // NODE_A in `ineligible`, not in `missing_revisions`.
    expect(missingHttp.some((m) => m.revision_id === revA)).toBe(false);
    expect(out.reconcile_http.body.ineligible as number).toBeGreaterThanOrEqual(1);

    expect(out.reconcile_mcp.ok, JSON.stringify(out.reconcile_mcp)).toBe(true);
    expect(typeof out.reconcile_mcp.value.visited).toBe("number");

    // ── authorization on the real gate ─────────────────────────────────
    expect(out.authz_read_refused_http.status, JSON.stringify(out.authz_read_refused_http)).toBe(403);
    expect(out.authz_read_refused_mcp).toEqual({ denied: "forbidden" });
    expect(out.authz_other_refused_read_http.status, JSON.stringify(out.authz_other_refused_read_http)).toBe(403);
    expect(out.authz_other_refused_read_mcp).toEqual({ denied: "forbidden" });
    expect(out.authz_other_refused_write_http.status, JSON.stringify(out.authz_other_refused_write_http)).toBe(403);
  },
  TEST_TIMEOUT_MS,
);
