// Step-list builder for `knowledge-expose13-live.test.ts`, split out to keep
// that file under Nat's 500-line cap. This is pure step-payload data (no
// test/assert code moved: `test(`/`expect()` counts in the live file are
// unchanged by this split) -- see that file's header comment for what the
// live #31 proof covers end to end, over both HTTP and MCP, against a real
// writer-gated target-19 dataset.

import { revisionEnvelope, type Fixture } from "./publication-fixture";
import { activeEmbeddingProfileId } from "../../src/publication/search-chunk";

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

/** Referenced by the live test's own assertions too, so exported here as the
 *  single source of truth rather than duplicated. */
export const SESSION_1_NAME = "expose13-session-a";
export const SESSION_2_NAME = "expose13-session-b";

const CHUNKER_VERSION = "chunker/v1";
// #30 R7: `indexRevisionChunks`/`listSearchChunks` now refuse any
// `embedding_profile` name outside the closed registry.
const EMBEDDING_PROFILE_NAME = activeEmbeddingProfileId();

export type Step = {
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

export function buildExpose13LiveSteps(alpha: string, seededAlpha: Fixture["workspaces"][string]): Step[] {
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
    workspace_name: alpha,
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
    workspace_name: alpha,
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
    workspace_name: alpha,
    node_id: NODE_A,
    expected_revision_id: "@REV_A",
    new_node_id: NODE_B,
    new_revision_id: "@REV_B",
    reason: "superseded by a newer note",
    peer_name: null,
    operation_id: "expose13-op-supersede-1",
  });

  const retireRequest = () => ({
    workspace_name: alpha,
    node_id: NODE_C,
    expected_revision_id: "@REV_C",
    reason: "no longer needed",
    peer_name: null,
    operation_id: "expose13-op-retire-1",
  });

  const indexRequest = (nodeId: string, revisionId: string) => ({
    workspace_name: alpha,
    node_id: nodeId,
    revision_id: revisionId,
    chunker_version: CHUNKER_VERSION,
    embedding_profile: { name: EMBEDDING_PROFILE_NAME, dims: 384 },
  });

  const listChunksRequest = (revisionId: string) => ({
    workspace_name: alpha,
    revision_id: revisionId,
    chunker_version: CHUNKER_VERSION,
    embedding_profile: EMBEDDING_PROFILE_NAME,
  });

  const embedRequest = (id: string, fill: number) => ({
    workspace_name: alpha,
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
      { operation_id: "expose13-op-a1", content: revisionEnvelope(alpha, seededAlpha, NODE_A, { title: "node A" }) },
      { capture: { name: "REV_A", path: ["revision_id"] } },
    ),
    s(
      "pub_B",
      "http",
      "write",
      "publishRevision",
      { operation_id: "expose13-op-b1", content: revisionEnvelope(alpha, seededAlpha, NODE_B, { title: "node B" }) },
      { capture: { name: "REV_B", path: ["revision_id"] } },
    ),
    s(
      "pub_C",
      "http",
      "write",
      "publishRevision",
      { operation_id: "expose13-op-c1", content: revisionEnvelope(alpha, seededAlpha, NODE_C, { title: "node C" }) },
      { capture: { name: "REV_C", path: ["revision_id"] } },
    ),
    s(
      "pub_X",
      "http",
      "write",
      "publishRevision",
      {
        operation_id: "expose13-op-x1",
        content: revisionEnvelope(alpha, seededAlpha, NODE_X, { title: "chunk source X", body: "chunk source body X" }),
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
        content: revisionEnvelope(alpha, seededAlpha, NODE_Y, { title: "chunk source Y", body: "chunk source body Y" }),
      },
      { capture: { name: "REV_Y", path: ["revision_id"] } },
    ),
    s("reg_s1", "http", "write", "registerSession", {
      workspace_name: alpha,
      session_id: SESSION_1_ID,
      name: SESSION_1_NAME,
    }),
    s("reg_s2", "http", "write", "registerSession", {
      workspace_name: alpha,
      session_id: SESSION_2_ID,
      name: SESSION_2_NAME,
    }),

    // ── #28 trace: createTrace -> getTrace -> listTraceHits ────────────────
    s("trace_create_http", "http", "write", "createTrace", traceRequest(TRACE_1)),
    s("trace_create_mcp_replay", "mcp", "write", "createTrace", traceRequest(TRACE_1)),
    s("trace_get_http", "http", "read", "getTrace", { workspace_name: alpha, id: TRACE_1 }),
    s("trace_get_mcp", "mcp", "read", "getTrace", { workspace_name: alpha, id: TRACE_1 }),
    s("trace_hits_http", "http", "read", "listTraceHits", {
      workspace_name: alpha,
      trace_id: TRACE_1,
      after_position: null,
      limit: 10,
    }),
    s("trace_hits_mcp", "mcp", "read", "listTraceHits", {
      workspace_name: alpha,
      trace_id: TRACE_1,
      after_position: null,
      limit: 10,
    }),

    // ── #28 session links: createSessionLink -> listSessionLinks ──────────
    s("link_create_http", "http", "write", "createSessionLink", linkRequest()),
    s("link_create_mcp_replay", "mcp", "write", "createSessionLink", linkRequest()),
    s("link_list_from_http", "http", "read", "listSessionLinks", {
      workspace_name: alpha,
      session_name: SESSION_1_NAME,
      direction: "from",
      cursor: null,
      limit: 10,
    }),
    s("link_list_to_mcp", "mcp", "read", "listSessionLinks", {
      workspace_name: alpha,
      session_name: SESSION_2_NAME,
      direction: "to",
      cursor: null,
      limit: 10,
    }),
    // #28 Unit B's mixed continues/forked_from cycle-refusal live proof moved
    // to `knowledge-expose13-live-cycle.test.ts` (500-line cap), its own
    // gated child run against the same shared `child.ts` transport driver.

    // ── #29 lifecycle: retireNode/supersedeNode -> listLifecycleHistory -> getRecallEligibility ──
    s("supersede_http", "http", "write", "supersedeNode", supersedeRequest()),
    s("supersede_mcp_replay", "mcp", "write", "supersedeNode", supersedeRequest()),
    s("retire_http", "http", "write", "retireNode", retireRequest()),
    s("retire_mcp_replay", "mcp", "write", "retireNode", retireRequest()),
    s("history_A_http", "http", "read", "listLifecycleHistory", {
      workspace_name: alpha,
      node_id: NODE_A,
      after_event_id: null,
      limit: 10,
    }),
    s("history_C_mcp", "mcp", "read", "listLifecycleHistory", {
      workspace_name: alpha,
      node_id: NODE_C,
      after_event_id: null,
      limit: 10,
    }),
    s("eligibility_A_http", "http", "read", "getRecallEligibility", { workspace_name: alpha, node_id: NODE_A }),
    s("eligibility_C_mcp", "mcp", "read", "getRecallEligibility", { workspace_name: alpha, node_id: NODE_C }),

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
    s("reconcile_http", "http", "write", "reconcileSearchChunks", { workspace_name: alpha, limit: 50 }),
    s("reconcile_mcp", "mcp", "write", "reconcileSearchChunks", { workspace_name: alpha, limit: 50 }),

    // ── authorization spot checks on the real gate ─────────────────────────
    s("authz_read_refused_http", "http", "read", "createTrace", traceRequest(TRACE_2)),
    s("authz_read_refused_mcp", "mcp", "read", "createTrace", traceRequest(TRACE_2)),
    s(
      "authz_other_refused_read_http",
      "http",
      "other",
      "getRecallEligibility",
      { workspace_name: alpha, node_id: NODE_A },
    ),
    s(
      "authz_other_refused_read_mcp",
      "mcp",
      "other",
      "getRecallEligibility",
      { workspace_name: alpha, node_id: NODE_A },
    ),
    s("authz_other_refused_write_http", "http", "other", "supersedeNode", supersedeRequest()),
  ];
}
