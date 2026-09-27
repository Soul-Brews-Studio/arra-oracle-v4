/**
 * #28 AC-evidence slice (docs/overnight/AC-MATRIX.md C6): the matrix found
 * `service.assertTraceChain.ts` HAS a stored-cycle guard (the `seen.has(id)`
 * branch) but no dedicated test named it. This is that test: a pin, not a
 * failing-first fix, because the behaviour already exists.
 *
 * Mutation check performed by hand while writing this file (not committed):
 * commenting out the `if (seen.has(id)) failPublication("integrity_failure",
 * "")` line in `service.assertTraceChain.ts` turned this test red (a stored
 * 2-cycle was walked forever until the 1024-hop `limit_exceeded` bound fired
 * instead of the immediate `integrity_failure`); restoring the line turned it
 * green again. See docs/overnight/AC-MATRIX.md row #28/TODO for the citation.
 *
 * Fix-round addition (independent Opus verifier, 2026-09-27): the first pass
 * above only pinned the `parent_id` call site
 * (`service.createTrace.ts:187-191`). The verifier replaced the SEPARATE
 * `prev_id` call site three lines below it
 * (`await assertTraceChain(writer, request.workspace_name, prev, "prev_id")`
 * at `service.createTrace.ts:195`) with a no-op and reported that all 61
 * trace tests, including this file, still passed -- because nothing here
 * exercised a STORED `prev_id` cycle. The two `"a stored ... prev_id ..."`
 * tests below close that gap: they are the `prev_id` mirror of the two
 * `parent_id` tests above, planted the same way via `insertRawTrace`.
 * Mutation check performed by hand while adding them: no-op'ing the
 * `assertTraceChain(..., "prev_id")` call in `service.createTrace.ts` (the
 * exact edit the verifier described, not the shared guard inside
 * `assertTraceChain.ts`) turned both new tests red (`ok: true` instead of an
 * `integrity_failure`); restoring the call turned them green again. The two
 * original `parent_id` tests above were unaffected either way, confirming
 * the two call sites are independently guarded and independently tested.
 */

import { describe, expect, test } from "bun:test";
import { runGated } from "./helpers/publication-fixture";
import { createTraceFixture, createTraceRequest, traceId } from "./helpers/trace-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

describe("assertTraceChain: a STORED cycle is refused, never walked forever", () => {
  const CHILD = new URL("./fixtures/trace-v1/core/gated-trace.ts", import.meta.url).pathname;
  const ALPHA = "alpha-workspace";
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  const drive = async (root: string, ops: Array<Record<string, unknown>>) => {
    const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK })]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
    return JSON.parse(line) as Record<string, any>;
  };
  const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
  const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

  test("a stored 2-node parent_id cycle (B->C->B) fails createTrace's ancestry walk with integrity_failure, not a hang", async () => {
    // B and C are planted DIRECTLY via the harness, each naming the OTHER as
    // parent_id -- a well-behaved writer (createTrace) can never produce this
    // itself, since a new row cannot reference a row that does not exist yet.
    // This is exactly the "STORED state: ... a self-referencing cycle" the
    // function's own docstring names.
    const idB = traceId("cycleB");
    const idC = traceId("cycleC");
    const idD = traceId("cycleD");
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        hx("insertRawTrace", {
          id: idB, workspace_name: ALPHA, name: "b", query: "q", depth: "0", status: "open",
          parent_id: idC, created_at_millis: CLOCK.toString(10), updated_at_millis: CLOCK.toString(10),
        }),
        hx("insertRawTrace", {
          id: idC, workspace_name: ALPHA, name: "c", query: "q", depth: "0", status: "open",
          parent_id: idB, created_at_millis: CLOCK.toString(10), updated_at_millis: CLOCK.toString(10),
        }),
        // A fresh, otherwise-valid create pointing INTO the corrupted chain.
        ctx("createTrace", createTraceRequest(ALPHA, { id: idD, parent_id: idB, depth: "1" })),
      ]);
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);

      const attempt = parsed.op2;
      expect(attempt.ok, JSON.stringify(attempt)).toBe(false);
      expect(attempt).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "integrity_failure",
      });
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a stored self-referencing trace (A.parent_id = A.id) is refused the same way", async () => {
    const idA = traceId("selfLoopA");
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        hx("insertRawTrace", {
          id: idA, workspace_name: ALPHA, name: "a", query: "q", depth: "0", status: "open",
          parent_id: idA, created_at_millis: CLOCK.toString(10), updated_at_millis: CLOCK.toString(10),
        }),
        ctx("createTrace", createTraceRequest(ALPHA, { id: traceId("childOfA"), parent_id: idA, depth: "1" })),
      ]);
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      const attempt = parsed.op1;
      expect(attempt.ok, JSON.stringify(attempt)).toBe(false);
      expect(attempt).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "integrity_failure",
      });
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a stored 2-node prev_id cycle (B->C->B) fails createTrace's prev walk with integrity_failure, not a hang", async () => {
    // The prev_id mirror of the parent_id test above: B and C name each
    // OTHER as prev_id, planted directly via the harness (createTrace can
    // never produce this itself). depth stays "0" and parent_id stays null
    // throughout -- prev_id has no bearing on depth (service.createTrace.ts's
    // own K13 comment), so this isolates the prev_id call site.
    const idB = traceId("prevCycB");
    const idC = traceId("prevCycC");
    const idD = traceId("prevCycD");
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        hx("insertRawTrace", {
          id: idB, workspace_name: ALPHA, name: "b", query: "q", depth: "0", status: "open",
          prev_id: idC, created_at_millis: CLOCK.toString(10), updated_at_millis: CLOCK.toString(10),
        }),
        hx("insertRawTrace", {
          id: idC, workspace_name: ALPHA, name: "c", query: "q", depth: "0", status: "open",
          prev_id: idB, created_at_millis: CLOCK.toString(10), updated_at_millis: CLOCK.toString(10),
        }),
        // A fresh, otherwise-valid create pointing INTO the corrupted chain
        // via prev_id (not parent_id).
        ctx("createTrace", createTraceRequest(ALPHA, { id: idD, prev_id: idB, depth: "0" })),
      ]);
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);

      const attempt = parsed.op2;
      expect(attempt.ok, JSON.stringify(attempt)).toBe(false);
      expect(attempt).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "integrity_failure",
      });
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a stored self-referencing prev_id trace (A.prev_id = A.id) is refused the same way", async () => {
    const idA = traceId("prevSelfA");
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        hx("insertRawTrace", {
          id: idA, workspace_name: ALPHA, name: "a", query: "q", depth: "0", status: "open",
          prev_id: idA, created_at_millis: CLOCK.toString(10), updated_at_millis: CLOCK.toString(10),
        }),
        ctx("createTrace", createTraceRequest(ALPHA, { id: traceId("prevChildA"), prev_id: idA, depth: "0" })),
      ]);
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      const attempt = parsed.op1;
      expect(attempt.ok, JSON.stringify(attempt)).toBe(false);
      expect(attempt).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "integrity_failure",
      });
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});
