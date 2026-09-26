/**
 * #29 slice B fix round: pins the exact half-open boundary semantics of
 * `evaluateNodeEligibility`'s validity window, and the `asOf` guard added in
 * this round.
 *
 * The independent verifier's mutation pass found two survivors against
 * `lifecycle-eligibility.test.ts`'s existing window test: flipping
 * `asOf >= validTo` to `asOf > validTo`, and flipping `asOf < validFrom` to
 * `asOf <= validFrom`, both still passed every existing assertion because
 * none of them probed the EXACT boundary instant, only points well before
 * and after it. This file adds that: `validFrom - 1ms`, `validFrom` itself,
 * `validTo - 1ms` and `validTo` itself, on both sides of each mutation.
 *
 * It also pins the NEW `asOf` finiteness guard (fix round): a non-finite
 * `asOf` used to silently make every window comparison `false`, reading as
 * eligible -- a real gap the verifier's probe found, reachable only from
 * in-process code (the transport always supplies a real `Date.now()`), but
 * cheap to close and worth pinning now that it is closed.
 */

import { describe, expect, test } from "bun:test";
import {
  createFixture,
  encodeRequest,
  revisionEnvelope,
  runGated,
  type Fixture,
} from "./helpers/publication-fixture";
import { openContextReader } from "../src/publication/service";
import { PublicationError } from "../src/publication/errors";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/lifecycle-v1/core/gated-lifecycle.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });

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

describe("#29 slice B fix round: validity window is a genuinely HALF-OPEN [valid_from, valid_to) interval", () => {
  test("valid_from: 1ms before is not_yet_valid, AT the instant is eligible", async () => {
    const NODE = idOf("boundaryFrom");
    const REV = idOf("boundaryFromR");
    const validFrom = "2027-01-01T00:00:00.000Z";
    const atFrom = Date.parse(validFrom);

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture,
        [pub("publishRevision", { operation_id: "op-from", content: revisionEnvelope(ALPHA, alpha, NODE, { valid_from: validFrom }) })],
        [REV],
      );
      expect(ok(parsed.op0, "publish").outcome).toBe("accepted");

      const reader = await openContextReader(fixture.datasetRoot);
      const eligibility = (asOf: number) =>
        reader.context.getRecallEligibility(
          encodeRequest({ workspace_name: ALPHA, node_id: NODE }),
          asOf,
        ) as Promise<{ eligible: boolean; reasons: string[] }>;

      const oneMsBefore = await eligibility(atFrom - 1);
      expect(oneMsBefore.eligible).toBe(false);
      expect(oneMsBefore.reasons).toEqual(["not_yet_valid"]);

      // AT the instant: valid_from is INCLUSIVE. A mutation flipping `<` to
      // `<=` would make this ALSO not_yet_valid -- this is what catches it.
      const atInstant = await eligibility(atFrom);
      expect(atInstant.eligible).toBe(true);
      expect(atInstant.reasons).toEqual([]);

      const oneMsAfter = await eligibility(atFrom + 1);
      expect(oneMsAfter.eligible).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));

  test("valid_to: 1ms before is eligible, AT the instant is expired", async () => {
    const NODE = idOf("boundaryTo");
    const REV = idOf("boundaryToR");
    const validTo = "2027-01-01T00:00:00.000Z";
    const atTo = Date.parse(validTo);

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture,
        [pub("publishRevision", { operation_id: "op-to", content: revisionEnvelope(ALPHA, alpha, NODE, { valid_to: validTo }) })],
        [REV],
      );
      expect(ok(parsed.op0, "publish").outcome).toBe("accepted");

      const reader = await openContextReader(fixture.datasetRoot);
      const eligibility = (asOf: number) =>
        reader.context.getRecallEligibility(
          encodeRequest({ workspace_name: ALPHA, node_id: NODE }),
          asOf,
        ) as Promise<{ eligible: boolean; reasons: string[] }>;

      const oneMsBefore = await eligibility(atTo - 1);
      expect(oneMsBefore.eligible).toBe(true);
      expect(oneMsBefore.reasons).toEqual([]);

      // AT the instant: valid_to is EXCLUSIVE -- no longer valid AT it, not
      // only after it. A mutation flipping `>=` to `>` would make this
      // WRONGLY eligible -- this is what catches it.
      const atInstant = await eligibility(atTo);
      expect(atInstant.eligible).toBe(false);
      expect(atInstant.reasons).toEqual(["expired"]);

      const oneMsAfter = await eligibility(atTo + 1);
      expect(oneMsAfter.eligible).toBe(false);
      expect(oneMsAfter.reasons).toEqual(["expired"]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));

  test("a non-finite as_of is refused as invalid_request, never silently read as eligible (fix round)", async () => {
    const NODE = idOf("boundaryNaN");
    const REV = idOf("boundaryNaNR");
    const validFrom = "2027-01-01T00:00:00.000Z";

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture,
        [pub("publishRevision", { operation_id: "op-nan", content: revisionEnvelope(ALPHA, alpha, NODE, { valid_from: validFrom }) })],
        [REV],
      );
      expect(ok(parsed.op0, "publish").outcome).toBe("accepted");

      const reader = await openContextReader(fixture.datasetRoot);
      const request = encodeRequest({ workspace_name: ALPHA, node_id: NODE });

      for (const badAsOf of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        let threw: unknown = null;
        try {
          // Before the fix-round guard, this silently returned `eligible:
          // true` -- `asOf < Date.parse(validFrom)` and `asOf >=
          // Date.parse(validTo)` are both `false` for a non-finite `asOf`,
          // so neither window reason was ever added.
          await reader.context.getRecallEligibility(request, badAsOf);
        } catch (error) {
          threw = error;
        }
        expect(threw, `asOf=${badAsOf} should have thrown`).toBeInstanceOf(PublicationError);
        expect((threw as PublicationError).code).toBe("invalid_request");
      }
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));
});
