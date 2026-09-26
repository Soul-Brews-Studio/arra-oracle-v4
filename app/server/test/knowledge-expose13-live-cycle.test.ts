// #28 Unit B live proof, split out of `knowledge-expose13-live.test.ts` (the
// 500-line cap): the mixed continues/forked_from session-link cycle refusal,
// against a REAL target-19 LanceDB dataset created by the accepted Python
// exporter and written inside the REAL writer gate (fd 42) -- no facade is
// called directly, no store is faked. Runs the SAME shared transport child,
// `test/fixtures/transport-v1/expose13/child.ts`, as the rest of the #31
// expose13 live suite; see that file's header comment for what it covers.
//
// Session-link-v1.md Decision 4's 2026-09-26 amendment (overnight R7 (#28
// part), Unit B): once a REAL createSessionLink lands SESSION_1
// --continues--> SESSION_2 over HTTP, the REVERSE edge SESSION_2
// --forked_from--> SESSION_1 closes a two-node loop that crosses relations,
// and must be refused exactly like a same-relation loop -- over the REAL
// transport, not just the in-process kernel tests in
// `session-link-service.test.ts` / `session-link-cycle.test.ts`.

import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, PYTHON, runGated, type Fixture } from "./helpers/publication-fixture";

const TEST_DIR = import.meta.dir;
const CHILD = join(TEST_DIR, "fixtures", "transport-v1", "expose13", "child.ts");
const TEST_TIMEOUT_MS = 120_000;

const ALPHA = "alpha-workspace";
// The transport child's policy fixture always writes a `beta-write`
// principal keyed off `payload.banks.beta` (see `child.ts`'s `writePolicy`).
// No step in this file uses the "other" token or the "beta" bank, so this
// name is never dereferenced against the dataset and is not seeded.
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

const LINK_1 = pad("expose13cyclelnk1");
const LINK_2 = pad("expose13cyclelnk2");
const SESSION_1_ID = pad("expose13cyclesA");
const SESSION_2_ID = pad("expose13cyclesB");
const SESSION_1_NAME = "expose13-cycle-session-a";
const SESSION_2_NAME = "expose13-cycle-session-b";

type Step = {
  label: string;
  transport: "http" | "mcp";
  token: "write" | "read" | "other";
  bank: "alpha" | "beta";
  method: string;
  body: unknown;
};

function buildSteps(): Step[] {
  const s = (
    label: string,
    transport: Step["transport"],
    method: string,
    body: unknown,
  ): Step => ({ label, transport, token: "write", bank: "alpha", method, body });

  const forwardLinkRequest = () => ({
    id: LINK_1,
    workspace_name: ALPHA,
    from_session_name: SESSION_1_NAME,
    to_session_name: SESSION_2_NAME,
    relation: "continues",
    evidence_ref: null,
    created_by_peer_name: null,
  });

  const reverseCrossRelationLinkRequest = () => ({
    id: LINK_2,
    workspace_name: ALPHA,
    from_session_name: SESSION_2_NAME,
    to_session_name: SESSION_1_NAME,
    relation: "forked_from",
    evidence_ref: null,
    created_by_peer_name: null,
  });

  return [
    s("reg_s1", "http", "registerSession", { workspace_name: ALPHA, session_id: SESSION_1_ID, name: SESSION_1_NAME }),
    s("reg_s2", "http", "registerSession", { workspace_name: ALPHA, session_id: SESSION_2_ID, name: SESSION_2_NAME }),
    s("link_create_http", "http", "createSessionLink", forwardLinkRequest()),
    // Unit B live proof: the mixed continues/forked_from cycle is refused
    // over BOTH transports, against the SAME real dataset state (LINK_2 is
    // never written by either attempt, so the MCP retry hits the identical
    // fresh-write cycle check the HTTP attempt did, not a replay).
    s("link_reverse_cycle_refused_http", "http", "createSessionLink", reverseCrossRelationLinkRequest()),
    s("link_reverse_cycle_refused_mcp", "mcp", "createSessionLink", reverseCrossRelationLinkRequest()),
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
  "a mixed continues/forked_from session-link cycle is refused live, over both HTTP and MCP",
  async () => {
    const fixture = await createFixture([ALPHA]);
    cleanups.push(fixture.cleanup);

    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-expose13-live-cycle-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const steps = buildSteps();
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
    expect(out.reg_s1, JSON.stringify(out.reg_s1)).toMatchObject({ status: 200 });
    expect(out.reg_s2, JSON.stringify(out.reg_s2)).toMatchObject({ status: 200 });
    expect(out.link_create_http.status, JSON.stringify(out.link_create_http)).toBe(200);
    expect(out.link_create_http.body.outcome).toBe("created");

    // Unit B: a mixed continues/forked_from cycle is refused live, over both
    // transports -- HTTP maps `invalid_request` to 400 (`STATUS_FOR_CODE`),
    // MCP carries the same governed envelope as `isError` text.
    expect(out.link_reverse_cycle_refused_http.status, JSON.stringify(out.link_reverse_cycle_refused_http)).toBe(400);
    expect(out.link_reverse_cycle_refused_http.body).toMatchObject({
      version: "arra-publication-error/v1",
      code: "invalid_request",
      path: "/to_session_name",
    });
    expect(out.link_reverse_cycle_refused_mcp.isError, JSON.stringify(out.link_reverse_cycle_refused_mcp)).toBe(true);
    expect(JSON.parse(out.link_reverse_cycle_refused_mcp.message)).toMatchObject({
      version: "arra-publication-error/v1",
      code: "invalid_request",
      path: "/to_session_name",
    });
  },
  TEST_TIMEOUT_MS,
);
