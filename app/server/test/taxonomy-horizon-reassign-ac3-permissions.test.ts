/**
 * #27 AC3, the "permissions" clause (AC-MATRIX row 1(d); ac-guards round 4):
 * "reassigning a node's memory_horizon changes nothing about correctness,
 * permissions or expiry". `taxonomy-horizon-reassign-ac3.test.ts` pins the
 * expiry / no-decay half at the kernel; this file pins permissions at the
 * only layer that decides them -- the transport, per request, from the
 * caller's credential (`src/knowledge/registry.ts`'s dispatch table, shared
 * by HTTP and MCP).
 *
 * Verifier finding (round 3): a horizon-dependent authorization rule in
 * `registry.ts` (getAcceptedHead throws `forbidden` whenever the head carries
 * long_term) left every slice file and 13 transport/auth/seal files green.
 * This test publishes ONE node as short_term, reassigns it to long_term, then
 * drops the horizon, all over the real wire, and after each phase asks the
 * same reads with three principals on both transports:
 *
 *   write  content:read+write on alpha   -> allowed
 *   read   content:read on alpha          -> allowed
 *   other  content:read+write on beta     -> refused (403 / MCP `forbidden`)
 *
 * plus one write attempt by `read` (refused in every phase). The permission
 * matrix and every allowed answer must be identical across the three phases.
 *
 * The wire is the accepted `fixtures/transport-v1/expose13/child.ts` (real
 * `createApp` + `createKnowledgeAccess` + MCP adapter inside the writer gate),
 * used as-is: it already carries exactly these three principals and the
 * `capture`/`"@name"` substitution a writer-assigned revision id needs. The
 * long_term phase mints its term with `createTerm`, which works only because
 * the test fixture declares memory_horizon term_policy "open" (production
 * seals it; see the sibling AC3 file); the horizon-dropped phase needs no
 * minted term. `valid_to` is null so the live `Date.now()` the transport
 * supplies to eligibility reads can never cross the window.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, revisionEnvelope, runGated } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/transport-v1/expose13/child.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const TEST_TIMEOUT_MS = testTimeout(180_000);

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const NODE_H = idOf("acgPermNode");
const NODE_W = idOf("acgPermReaderWrite");
const LONG_TERM = idOf("acgPermLongTerm");

type Transport = "http" | "mcp";
type Token = "write" | "read" | "other";
type Step = {
  label: string;
  transport: Transport;
  token: Token;
  bank: "alpha" | "beta";
  method: string;
  body: unknown;
  capture?: { name: string; path: (string | number)[] };
};

const TRANSPORTS: Transport[] = ["http", "mcp"];
const TOKENS: Token[] = ["write", "read", "other"];
const ALLOWED: Record<Token, boolean> = { write: true, read: true, other: false };

const listRequest = (eligibleOnly: boolean) => ({
  workspace_name: ALPHA,
  after_id: null,
  limit: 100,
  include_total: true,
  type_term: null,
  include_inactive: false,
  ...(eligibleOnly ? { eligible_only: true } : {}),
});
const READS: Array<{ name: string; method: string; body: unknown }> = [
  { name: "head", method: "getAcceptedHead", body: { workspace_name: ALPHA, node_id: NODE_H } },
  { name: "eligibility", method: "getRecallEligibility", body: { workspace_name: ALPHA, node_id: NODE_H } },
  { name: "list", method: "listNodes", body: listRequest(false) },
  { name: "listEligible", method: "listNodes", body: listRequest(true) },
];

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Allowed -> the answer itself; refused -> the refusal. Throws on anything else. */
const settle = (transport: Transport, outcome: any, where: string): { allowed: boolean; value: any } => {
  if (transport === "http") {
    if (outcome?.status === 200) return { allowed: true, value: outcome.body };
    if (outcome?.status === 403) return { allowed: false, value: outcome.body?.code ?? outcome.body?.error ?? null };
  } else {
    if (outcome?.ok === true) return { allowed: true, value: outcome.value };
    if (outcome?.denied === "forbidden") return { allowed: false, value: "forbidden" };
  }
  throw new Error(`${where}: neither allowed nor refused: ${JSON.stringify(outcome).slice(0, 500)}`);
};

describe("#27 AC3: reassigning memory_horizon leaves permissions unchanged on HTTP and MCP", () => {
  test("the same principals are allowed and refused, with the same answers, in every horizon phase", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-acg-horizon-perm-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const alpha = fixture.workspaces[ALPHA]!;
    const shortTerm = alpha.term_ids.memory_horizon.short_term;
    const typeTerm = alpha.term_ids.type.note;
    const snapshot = (horizon: { id: string; name: string } | null) =>
      JSON.stringify([
        {
          term_id: typeTerm.id,
          vocabulary_id: typeTerm.vocabulary_id,
          vocabulary_name_snapshot: "type",
          term_name_snapshot: "note",
          label_snapshot: null,
          position: "0",
        },
        ...(horizon === null
          ? []
          : [
              {
                term_id: horizon.id,
                vocabulary_id: shortTerm.vocabulary_id,
                vocabulary_name_snapshot: "memory_horizon",
                term_name_snapshot: horizon.name,
                label_snapshot: null,
                position: "1",
              },
            ]),
      ]);

    const phases = [
      { name: "short_term", horizon: { id: shortTerm.id, name: "short_term" }, base: null },
      { name: "long_term", horizon: { id: LONG_TERM, name: "long_term" }, base: "@REV0" },
      { name: "(none)", horizon: null, base: "@REV1" },
    ];

    const steps: Step[] = [];
    phases.forEach((phase, p) => {
      if (phase.name === "long_term") {
        steps.push({
          label: "createTerm long_term",
          transport: "http",
          token: "write",
          bank: "alpha",
          method: "createTerm",
          body: {
            workspace_name: ALPHA,
            term_id: LONG_TERM,
            vocabulary_id: shortTerm.vocabulary_id,
            name: "long_term",
            description: null,
            parent_id: null,
          },
        });
      }
      steps.push({
        label: `publish ${p}`,
        transport: "http",
        token: "write",
        bank: "alpha",
        method: "publishRevision",
        body: {
          operation_id: `op-acg-perm-${p}`,
          content: revisionEnvelope(ALPHA, alpha, NODE_H, {
            title: "horizon permissions note",
            base_revision_id: phase.base,
            valid_from: "2020-01-01T00:00:00.000Z",
            valid_to: null,
            term_snapshot_json: snapshot(phase.horizon),
          }),
        },
        capture: { name: `REV${p}`, path: ["revision_id"] },
      });
      for (const transport of TRANSPORTS) {
        for (const token of TOKENS) {
          for (const read of READS) {
            steps.push({ label: `${p} ${transport} ${token} ${read.name}`, transport, token, bank: "alpha", method: read.method, body: read.body });
          }
        }
        // A content:read principal still cannot write, whatever the horizon.
        steps.push({
          label: `${p} ${transport} read publish`,
          transport,
          token: "read",
          bank: "alpha",
          method: "publishRevision",
          body: {
            operation_id: `op-acg-perm-reader-${p}-${transport}`,
            content: revisionEnvelope(ALPHA, alpha, NODE_W, { title: "reader must not write" }),
          },
        });
      }
    });

    const result = await runGated(fixture.datasetRoot, CHILD, [
      fixture.datasetRoot,
      workDir,
      JSON.stringify({ banks: { alpha: ALPHA, beta: BETA }, steps }),
    ]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 1500)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
    const out: Record<string, any> = JSON.parse(line);

    expect(out["createTerm long_term"]?.status, JSON.stringify(out["createTerm long_term"])).toBe(200);

    // Per phase: who is allowed, and -- for the allowed -- the answer with
    // the revision id (the one thing a new revision must change) factored out.
    const matrices = phases.map((phase, p) => {
      const publish = out[`publish ${p}`];
      expect(publish?.status, `publish ${phase.name}: ${JSON.stringify(publish)}`).toBe(200);
      expect(publish.body.outcome).toBe("accepted");
      const rev = publish.body.revision_id as string;

      const matrix: Record<string, unknown> = {};
      for (const transport of TRANSPORTS) {
        for (const token of TOKENS) {
          for (const read of READS) {
            const where = `${phase.name}: ${transport} ${token} ${read.name}`;
            const { allowed, value } = settle(transport, out[`${p} ${transport} ${token} ${read.name}`], where);
            expect({ where, allowed }).toEqual({ where, allowed: ALLOWED[token] });
            if (!allowed) {
              matrix[where.slice(phase.name.length + 2)] = { allowed, value };
              continue;
            }
            let answer: unknown;
            if (read.name === "head") {
              expect(value.revision.id, where).toBe(rev);
              const horizon = (JSON.parse(value.revision.term_snapshot_json) as any[])
                .filter((t) => t.vocabulary_name_snapshot === "memory_horizon")
                .map((t) => t.term_name_snapshot);
              expect(horizon, where).toEqual(phase.horizon === null ? [] : [phase.horizon.name]);
              const r = value.revision;
              answer = { is_active: r.is_active, valid_from: r.valid_from, valid_to: r.valid_to, lifecycle: value.lifecycle };
            } else if (read.name === "eligibility") {
              expect({ where, eligible: value.eligible, reasons: value.reasons }).toEqual({ where, eligible: true, reasons: [] });
              answer = value;
            } else {
              const row = (value.rows as any[]).find((r) => r.id === NODE_H);
              expect(row, `${where}: ${JSON.stringify(value).slice(0, 400)}`).toBeDefined();
              answer = { ids: (value.rows as any[]).map((r) => r.id), total: value.total, lifecycle_state: row.lifecycle_state };
            }
            matrix[where.slice(phase.name.length + 2)] = { allowed, answer };
          }
        }
        const where = `${transport} read publish`;
        const refused = settle(transport, out[`${p} ${where}`], `${phase.name}: ${where}`);
        expect({ where: `${phase.name}: ${where}`, allowed: refused.allowed }).toEqual({ where: `${phase.name}: ${where}`, allowed: false });
        matrix[where] = refused;
      }
      return matrix;
    });

    // The whole matrix -- refusals included -- is identical before and after
    // each reassignment.
    const [first, ...rest] = matrices;
    for (const [r, later] of rest.entries()) {
      const where = `${phases[0]!.name} -> ${phases[r + 1]!.name}`;
      expect({ where, matrix: later }).toEqual({ where, matrix: first });
    }
  }, TEST_TIMEOUT_MS);
});
