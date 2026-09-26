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
//
// #28 Unit B's live mixed continues/forked_from cycle-refusal proof lives in
// `knowledge-expose13-live-cycle.test.ts`, split out to stay under the
// 500-line cap -- its own gated child run, against the same shared
// `fixtures/transport-v1/expose13/child.ts` transport driver.
//
// The step-payload data for the round trip below (13 methods, both
// transports) lives in `helpers/expose13-live-steps.ts`, also split out to
// stay under the cap -- pure request-building, no test/assert code there.

import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, PYTHON, runGated } from "./helpers/publication-fixture";
import { buildExpose13LiveSteps, SESSION_1_NAME, SESSION_2_NAME } from "./helpers/expose13-live-steps";

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

    const steps = buildExpose13LiveSteps(ALPHA, seededAlpha);
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
    // substitution exists (see the `Step["capture"]` doc comment in
    // `test/helpers/expose13-live-steps.ts`).
    const revA = out.pub_A.body.revision_id as string;
    const revB = out.pub_B.body.revision_id as string;
    const revC = out.pub_C.body.revision_id as string;
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
    // A (superseded by B, above) and C (retired, above) are both terminal by
    // this point in the run: #29 slice B reports a terminal node's absent
    // chunks as `ineligible`, never `missing` -- its content is superseded
    // or retired, not a backfill gap (DESIGN.md:1119). #30 R7's reconcile
    // (search-embed) applies the same `supersede_log` rule and excludes a
    // terminal node from missing/incomplete accounting entirely. B, A's
    // un-indexed successor, is still live and DOES show up as missing --
    // proving this reconcile call genuinely visited and distinguished real
    // rows, it did not just echo an empty report.
    expect(missingHttp.some((m) => m.revision_id === revA)).toBe(false);
    expect(missingHttp.some((m) => m.revision_id === revC)).toBe(false);
    expect(missingHttp.some((m) => m.revision_id === revB)).toBe(true);
    expect(out.reconcile_http.body.ineligible as number).toBeGreaterThanOrEqual(2);

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
