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
});
