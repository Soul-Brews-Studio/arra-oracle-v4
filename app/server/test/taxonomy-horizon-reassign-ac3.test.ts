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
 * revision's. The transport-level permission check is NOT pinned here.
 *
 * Round 3 (verifier blocker): the earlier version asked for eligibility
 * through the shared core child, which cannot forward a request time, so
 * `getRecallEligibility` fell back to `Date.now()`
 * (`service.getRecallEligibility.ts`'s `requestTimeMs ?? Date.now()`) and the
 * "expiry / no automatic decay" half was pinned only by the calendar: a
 * short_term-decays-after-30-days mutant stayed green. This version drives
 * the slice's own child (`ac-guards/gated-ac-guards.ts`), which forwards
 * `requestTimeMs` as the facade call's second argument exactly as the
 * transport does, and asks at fixed instants on both sides of both window
 * edges. Expected outcomes are written out per instant (not only compared
 * before/after), so a rule that moves BOTH sides the same way still goes
 * red. The revision clock sits one day after `valid_from`, so the latest
 * in-window instant is ~10 years after `created_at` and real `Date.now()` is
 * years after it too: an age-based decay term keyed to either goes red.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/lifecycle-v1/ac-guards/gated-ac-guards.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const TEST_TIMEOUT_MS = testTimeout(180_000);
const VALID_FROM = "2020-01-01T00:00:00.000Z";
const VALID_TO = "2030-01-01T00:00:00.000Z";
const VALID_FROM_MS = Date.parse(VALID_FROM);
const VALID_TO_MS = Date.parse(VALID_TO);
const DAY_MS = 86_400_000;
// Revision `created_at`. One day into the window, far from both today and
// the window's end -- see the header for why.
const CLOCK_MS = VALID_FROM_MS + DAY_MS;

type Instant = { label: string; at: number; eligible: boolean; reasons: string[] };

// The window is half-open, [valid_from, valid_to) (`service.eligibilityReasonsOf.ts`).
const INSTANTS: Instant[] = [
  { label: "1ms before valid_from", at: VALID_FROM_MS - 1, eligible: false, reasons: ["not_yet_valid"] },
  { label: "at valid_from", at: VALID_FROM_MS, eligible: true, reasons: [] },
  { label: "at created_at", at: CLOCK_MS, eligible: true, reasons: [] },
  { label: "created_at + 31 days", at: CLOCK_MS + 31 * DAY_MS, eligible: true, reasons: [] },
  { label: "1ms before valid_to", at: VALID_TO_MS - 1, eligible: true, reasons: [] },
  { label: "at valid_to", at: VALID_TO_MS, eligible: false, reasons: ["expired"] },
  { label: "10 years after valid_to", at: Date.parse("2040-01-01T00:00:00.000Z"), eligible: false, reasons: ["expired"] },
];

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const NODE_H = idOf("acgHorizonNode");
const REV_H1 = idOf("acgHorizonRev1");
const REV_H2 = idOf("acgHorizonRev2");
const REV_H3 = idOf("acgHorizonRev3");
const LONG_TERM = idOf("acgHorizonLongTerm");

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
  test("at fixed instants around both window edges, each horizon phase answers identically and as the window dictates", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const shortTerm = alpha.term_ids.memory_horizon.short_term;
      const typeTerm = alpha.term_ids.type.note;

      const termSnapshot = (horizon: { id: string; name: string } | null) =>
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

      // Three phases of ONE node: short_term, the reassignment to long_term,
      // then the horizon dropped altogether. Only the horizon term differs
      // between them; is_active and the validity window are held identical.
      const phases = [
        { name: "short_term", horizon: { id: shortTerm.id, name: "short_term" }, base: null, rev: REV_H1 },
        { name: "long_term", horizon: { id: LONG_TERM, name: "long_term" }, base: REV_H1, rev: REV_H2 },
        { name: "(none)", horizon: null, base: REV_H2, rev: REV_H3 },
      ];

      const ops: Array<Record<string, unknown>> = [];
      const push = (op: Record<string, unknown>) => `op${ops.push(op) - 1}`;

      // "long_term" is one of the two seeded HORIZON_TERMS names, but this
      // fixture only pre-creates "short_term" -- mint the sibling. This only
      // works because the test fixture declares `memory_horizon` with
      // term_policy "open" (migrate-py/tests/export_publication_fixture.py);
      // the production seed (taxonomy.seedVocabularyRows.ts) makes it
      // "sealed", where R6 would refuse this `createTerm`. The third phase
      // (horizon dropped) needs no minted term, so it holds on either shape.
      const createLabel = push({
        facade: "taxonomy",
        method: "createTerm",
        request: {
          workspace_name: ALPHA,
          term_id: LONG_TERM,
          vocabulary_id: shortTerm.vocabulary_id,
          name: "long_term",
          description: null,
          parent_id: null,
        },
      });

      const labels = phases.map((phase, index) => {
        const envelope = revisionEnvelope(ALPHA, alpha, NODE_H, {
          title: "horizon note",
          ...(phase.base === null ? {} : { base_revision_id: phase.base }),
          is_active: true,
          valid_from: VALID_FROM,
          valid_to: VALID_TO,
          term_snapshot_json: termSnapshot(phase.horizon),
        });
        return {
          publish: push({
            facade: "publication",
            method: "publishRevision",
            request: { operation_id: `op-acg-horizon-${index + 1}`, content: envelope },
          }),
          head: push({
            facade: "publication",
            method: "getAcceptedHead",
            request: { workspace_name: ALPHA, node_id: NODE_H },
          }),
          eligibility: INSTANTS.map((instant) =>
            push({
              facade: "context",
              method: "getRecallEligibility",
              request: { workspace_name: ALPHA, node_id: NODE_H },
              requestTimeMs: instant.at,
            }),
          ),
        };
      });

      const parsed = await drive(fixture, ops, phases.map((p) => p.rev));

      expect(ok(parsed[createLabel], "createTerm long_term").outcome).toBe("created");

      const observed = phases.map((phase, p) => {
        expect(ok(parsed[labels[p]!.publish], `publish ${phase.name}`).outcome).toBe("accepted");
        const head = ok(parsed[labels[p]!.head], `head ${phase.name}`);
        expect(head.revision.id).toBe(phase.rev);
        expect(termsOf(head.revision, "memory_horizon")).toEqual(phase.horizon === null ? [] : [phase.horizon.name]);
        const eligibility = INSTANTS.map((instant, i) =>
          ok(parsed[labels[p]!.eligibility[i]!], `eligibility ${phase.name} ${instant.label}`),
        );
        return { head, eligibility };
      });

      // The window alone decides, at every instant, in every horizon phase:
      // no horizon-dependent rule and no age-based decay moves an answer.
      for (const [p, phase] of phases.entries()) {
        for (const [i, instant] of INSTANTS.entries()) {
          const answer = observed[p]!.eligibility[i]!;
          const where = `${phase.name} @ ${instant.label}`;
          expect({ where, eligible: answer.eligible, reasons: answer.reasons }).toEqual({
            where,
            eligible: instant.eligible,
            reasons: instant.reasons,
          });
        }
      }

      // Same instant, same answer, byte-for-byte, before and after each
      // reassignment (witness_event_id included: no supersede_log row is
      // written by a horizon change).
      const [first, ...rest] = observed;
      for (const [r, later] of rest.entries()) {
        const where = `${phases[0]!.name} -> ${phases[r + 1]!.name}`;
        expect({ where, eligibility: later.eligibility }).toEqual({ where, eligibility: first!.eligibility });
        expect(later.head.revision.is_active).toBe(first!.head.revision.is_active);
        expect(later.head.revision.valid_from).toBe(first!.head.revision.valid_from);
        expect(later.head.revision.valid_to).toBe(first!.head.revision.valid_to);
        expect(later.head.lifecycle).toEqual(first!.head.lifecycle);
      }
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
