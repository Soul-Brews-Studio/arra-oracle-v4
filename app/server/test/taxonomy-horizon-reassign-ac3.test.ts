/**
 * #27 AC3 (AC-MATRIX row, ac-guards slice): "reassigning a node's
 * memory_horizon changes nothing about correctness, permissions or expiry;
 * no automatic decay." analysis-27.json found the code has no horizon-driven
 * behaviour at all (`rg horizon|decay|auto.?expir` in `src` hits only the
 * max-one cardinality check and the seed row), but no committed test ever
 * published a node, reassigned its horizon term on a later revision, and
 * asserted that everything else held still. This file is that pin.
 *
 * "Permissions" has no node-level column in this kernel -- authorization is
 * decided per REQUEST by the transport/policy layer from the caller's
 * credential, never stored on the node (the same separation
 * `service.eligibilityReasonsOf.ts`'s own comment draws for eligibility vs.
 * authorization). The kernel-level proxy this test measures is the one
 * DESIGN.md §9 actually ties to a node: `is_active`, `valid_from`, `valid_to`
 * and the derived `getRecallEligibility` outcome -- reassigning the horizon
 * term on a new revision must leave all four byte-identical to the prior
 * revision's.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/lifecycle-v1/core/gated-lifecycle.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");
const TEST_TIMEOUT_MS = testTimeout(180_000);
const VALID_FROM = "2020-01-01T00:00:00.000Z";
const VALID_TO = "2030-01-01T00:00:00.000Z";

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const NODE_H = idOf("acgHorizonNode");
const REV_H1 = idOf("acgHorizonRev1");
const REV_H2 = idOf("acgHorizonRev2");
const LONG_TERM = idOf("acgHorizonLongTerm");

const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const tax = (method: string, request: unknown) => ({ facade: "taxonomy", method, request });

const drive = async (fixture: Fixture, ops: Array<Record<string, unknown>>, revisionIds: string[]) => {
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops, revisionIds, clockMs: CLOCK_MS }),
  ]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
  return JSON.parse(line) as Record<string, any>;
};

const ok = (op: any, label: string) => {
  expect(op?.ok, `${label}: ${JSON.stringify(op).slice(0, 500)}`).toBe(true);
  return op.value;
};

const termsOf = (revision: any, vocabulary: string): string[] =>
  (JSON.parse(revision.term_snapshot_json) as Array<{ vocabulary_name_snapshot: string; term_name_snapshot: string }>)
    .filter((t) => t.vocabulary_name_snapshot === vocabulary)
    .map((t) => t.term_name_snapshot);

describe("#27 AC3: reassigning memory_horizon leaves validity, expiry and recall eligibility unchanged", () => {
  test("a correction that changes only the memory_horizon term leaves is_active/valid_from/valid_to/eligibility byte-identical", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const shortTerm = alpha.term_ids.memory_horizon.short_term;
      const typeTerm = alpha.term_ids.type.note;

      const termSnapshot = (horizonTermId: string, horizonName: string) =>
        JSON.stringify([
          {
            term_id: typeTerm.id,
            vocabulary_id: typeTerm.vocabulary_id,
            vocabulary_name_snapshot: "type",
            term_name_snapshot: "note",
            label_snapshot: null,
            position: "0",
          },
          {
            term_id: horizonTermId,
            vocabulary_id: shortTerm.vocabulary_id,
            vocabulary_name_snapshot: "memory_horizon",
            term_name_snapshot: horizonName,
            label_snapshot: null,
            position: "1",
          },
        ]);

      const rev1Envelope = revisionEnvelope(ALPHA, alpha, NODE_H, {
        title: "short-term note",
        is_active: true,
        valid_from: VALID_FROM,
        valid_to: VALID_TO,
        term_snapshot_json: termSnapshot(shortTerm.id, "short_term"),
      });
      const rev2Envelope = revisionEnvelope(ALPHA, alpha, NODE_H, {
        title: "short-term note",
        base_revision_id: REV_H1,
        is_active: true,
        valid_from: VALID_FROM,
        valid_to: VALID_TO,
        term_snapshot_json: termSnapshot(LONG_TERM, "long_term"),
      });

      const parsed = await drive(
        fixture,
        [
          // "long_term" is one of the two seeded HORIZON_TERMS names, but
          // this fixture only pre-creates "short_term" -- mint the sibling.
          // Fix round note (verifier finding, nonblocking): this only works
          // because the test fixture declares `memory_horizon` with
          // term_policy "open" (migrate-py/tests/export_publication_fixture.py).
          // The production seed (taxonomy.seedVocabularyRows.ts) makes it
          // "sealed", where R6 would refuse this very `createTerm` call. This
          // test therefore runs on a non-production vocabulary shape; a
          // sealed-vocabulary version of this AC is not covered here.
          tax("createTerm", {
            workspace_name: ALPHA,
            term_id: LONG_TERM,
            vocabulary_id: shortTerm.vocabulary_id,
            name: "long_term",
            description: null,
            parent_id: null,
          }),
          pub("publishRevision", { operation_id: "op-acg-horizon-1", content: rev1Envelope }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_H }),
          pub("getAcceptedHead", { workspace_name: ALPHA, node_id: NODE_H }),
          // The horizon reassignment: a new revision naming ONLY a different
          // memory_horizon term, everything else (including is_active and
          // the validity window) held identical.
          pub("publishRevision", { operation_id: "op-acg-horizon-2", content: rev2Envelope }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_H }),
          pub("getAcceptedHead", { workspace_name: ALPHA, node_id: NODE_H }),
        ],
        [REV_H1, REV_H2],
      );

      expect(ok(parsed.op0, "createTerm long_term").outcome).toBe("created");
      expect(ok(parsed.op1, "publish rev1 (short_term)").outcome).toBe("accepted");

      const eligBefore = ok(parsed.op2, "eligibility before reassignment");
      const headBefore = ok(parsed.op3, "head before reassignment");
      expect(termsOf(headBefore.revision, "memory_horizon")).toEqual(["short_term"]);

      expect(ok(parsed.op4, "publish rev2 (long_term correction)").outcome).toBe("accepted");

      const eligAfter = ok(parsed.op5, "eligibility after reassignment");
      const headAfter = ok(parsed.op6, "head after reassignment");
      expect(termsOf(headAfter.revision, "memory_horizon")).toEqual(["long_term"]);

      // Fix round (verifier finding, nonblocking): pin the STARTING state as
      // genuinely eligible first. Without this, two equally-ineligible states
      // (e.g. both "expired") would satisfy the toEqual below with no real
      // proof the horizon reassignment preserved an ELIGIBLE node's
      // eligibility, which is the AC's actual claim.
      expect(eligBefore.eligible).toBe(true);

      // The horizon term changed. Nothing else did.
      expect(eligAfter).toEqual(eligBefore);
      expect(headAfter.revision.is_active).toBe(headBefore.revision.is_active);
      expect(headAfter.revision.valid_from).toBe(headBefore.revision.valid_from);
      expect(headAfter.revision.valid_to).toBe(headBefore.revision.valid_to);
      expect(headAfter.lifecycle).toEqual(headBefore.lifecycle);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
