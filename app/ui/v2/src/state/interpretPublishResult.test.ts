/** Failing-first (fix round, 2026-09-27): the independent verifier showed the
 *  conflict-vs-success decision in `useKnowledge.publish` had no test of its
 *  own -- `bun test src` stayed 168/0 with `useKnowledge.ts` reverted to
 *  84061c9, and two mutants survived the WHOLE suite:
 *    - mutant G: `outcome === "conflict"` swapped for `outcome === "nope"`,
 *      so a real conflict resolves `true` and the caller navigates.
 *    - mutant F: `setError(describeConflict(reason))` swapped for
 *      `setError(null)`, so a refusal is silent.
 *  `interpretPublishResult` is that decision pulled out into a plain,
 *  DOM-free unit -- same shape as `applySearchOutcome` -- so a render-free
 *  test can pin it directly instead of only through a hook harness.
 *  `bun test src/state/interpretPublishResult.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { ApiResult } from "../api/client";
import { interpretPublishResult } from "./interpretPublishResult";

const describeFailure = (result: ApiResult): string => result.error ?? `HTTP ${result.status}`;

const ok = (body: unknown): ApiResult => ({ ok: true, status: 200, durationMs: 1, body });
const transportFailure = (): ApiResult => ({ ok: false, status: 503, durationMs: 1, body: null, error: "timeout" });

describe("interpretPublishResult", () => {
  test("an accepted outcome resolves ok", () => {
    expect(interpretPublishResult(ok({ outcome: "accepted" }), describeFailure)).toEqual({ ok: true });
  });

  test("an idempotent outcome resolves ok", () => {
    expect(interpretPublishResult(ok({ outcome: "idempotent" }), describeFailure)).toEqual({ ok: true });
  });

  test("a conflict outcome is a refusal, not a success -- this is the runtime bug that reached users", () => {
    const out = interpretPublishResult(ok({ outcome: "conflict", reason: "node_retired" }), describeFailure);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("superseded or retired");
  });

  test("a conflict's reason reaches the caller through describeConflict, not a generic message", () => {
    const out = interpretPublishResult(ok({ outcome: "conflict", reason: "stale_base" }), describeFailure);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("revised by someone else");
  });

  test("a transport failure (result.ok false) is a refusal using the caller's describe function", () => {
    const out = interpretPublishResult(transportFailure(), describeFailure);
    expect(out).toEqual({ ok: false, error: "timeout" });
  });
});
