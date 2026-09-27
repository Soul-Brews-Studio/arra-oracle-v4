/** Wave 5 hardening (#33): `useKnowledge.publish` resolved `true` on HTTP 200
 *  even when `publishRevision` reported `{outcome: "conflict", reason}` --
 *  measured live: publishing onto a superseded node returned
 *  `{"ok":true,"status":200,"body":{"outcome":"conflict"}}` and the UI
 *  navigated as if it had succeeded. `describeConflict` is the piece of that
 *  fix a test can pin without a hook renderer: the human-readable reason
 *  `useKnowledge.ts`'s `publish` now surfaces through `setError` instead of
 *  silently returning `true`. */
import { describe, expect, test } from "bun:test";
import { describeConflict } from "./describeConflict";

describe("describeConflict", () => {
  test("maps every documented conflict reason (service.types.ts PublishOutcome) to a human explanation", () => {
    expect(describeConflict("stale_base")).toContain("revised by someone else");
    expect(describeConflict("node_retired")).toContain("superseded or retired");
    expect(describeConflict("node_id")).toContain("already claims this node id");
    expect(describeConflict("operation_digest")).toContain("already used this operation id");
  });

  test("an unrecognized reason still surfaces verbatim rather than disappearing", () => {
    expect(describeConflict("something_new")).toBe("publish refused: something_new");
  });
});
