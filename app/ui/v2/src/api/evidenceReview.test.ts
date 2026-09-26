/** Tests for the PURE parsers in `api/evidenceReview.ts` -- everything here
 *  is a plain function over an already-received `ApiResult`, no `fetch`, no
 *  DOM: `bun test src/api/evidenceReview.test.ts`.
 *
 * Fix-round finding (nonblocking): none of these had a test before this
 * file, including the ones that shipped with #33's first pass
 * (`traceOf`, `hitsOf`, `sessionLinksOf`, `lifecycleHistoryOf`,
 * `recallEligibilityOf`, `isSupersedeEvent`). This file covers those PLUS
 * the new direct/reverse-evidence and lifecycle-write parsers this fix round
 * adds (`associationsOf`, `dependentsOf`, `lifecycleWriteOutcomeOf`).
 */
import { describe, expect, test } from "bun:test";
import type { ApiResult } from "./client";
import {
  associationsOf,
  dependentsOf,
  hitsOf,
  isSupersedeEvent,
  type LifecycleEventRow,
  lifecycleHistoryOf,
  lifecycleWriteOutcomeOf,
  recallEligibilityOf,
  sessionLinksOf,
  traceOf,
} from "./evidenceReview";

function ok(body: unknown): ApiResult {
  return { ok: true, status: 200, durationMs: 0, body };
}

function failed(status = 500): ApiResult {
  return { ok: false, status, durationMs: 0, body: null };
}

describe("traceOf", () => {
  test("a found trace is returned as-is", () => {
    const row = { id: "t1", name: "n", status: "open" };
    expect(traceOf(ok(row))).toEqual(row);
  });

  test("null is an ANSWER (no such trace), not treated as an error", () => {
    expect(traceOf(ok(null))).toBeNull();
  });

  test("a failed request reads as no trace, not a thrown shape mismatch", () => {
    expect(traceOf(failed())).toBeNull();
  });
});

describe("hitsOf", () => {
  test("reads rows and the cursor from the envelope", () => {
    const page = hitsOf(ok({ rows: [{ position: "0" }], next_after_position: "0" }));
    expect(page.rows).toEqual([{ position: "0" }]);
    expect(page.nextAfterPosition).toBe("0");
  });

  test("a malformed or failed body reads as an empty exhausted page, not a crash", () => {
    expect(hitsOf(ok({}))).toEqual({ rows: [], nextAfterPosition: null });
    expect(hitsOf(failed())).toEqual({ rows: [], nextAfterPosition: null });
  });
});

describe("sessionLinksOf", () => {
  test("reads rows and next_cursor", () => {
    const page = sessionLinksOf(ok({ rows: [{ id: "l1" }], next_cursor: "c1" }));
    expect(page.rows).toEqual([{ id: "l1" }]);
    expect(page.nextCursor).toBe("c1");
  });

  test("a failed request reads as an empty page", () => {
    expect(sessionLinksOf(failed())).toEqual({ rows: [], nextCursor: null });
  });
});

describe("lifecycleHistoryOf", () => {
  test("reads rows and next_after_event_id", () => {
    const page = lifecycleHistoryOf(ok({ rows: [{ id: "e1" }], next_after_event_id: "e1" }));
    expect(page.rows).toEqual([{ id: "e1" }]);
    expect(page.nextAfterEventId).toBe("e1");
  });
});

describe("isSupersedeEvent", () => {
  const base: LifecycleEventRow = {
    id: "e1",
    workspace_name: "w",
    old_id: "n1",
    old_revision_id: "r1",
    old_title: "t",
    old_type: "note",
    new_id: null,
    new_revision_id: null,
    new_title: null,
    reason: "r",
    peer_name: null,
    superseded_at: "2026-09-27T00:00:00.000Z",
    operation_id: "op1",
    h_metadata: null,
  };

  test("both new_id and new_revision_id present is a supersede event", () => {
    expect(isSupersedeEvent({ ...base, new_id: "n2", new_revision_id: "r2" })).toBe(true);
  });

  test("both null is a retirement", () => {
    expect(isSupersedeEvent(base)).toBe(false);
  });
});

describe("recallEligibilityOf", () => {
  test("reads a well-shaped body", () => {
    expect(recallEligibilityOf(ok({ eligible: true, witness_event_id: "e1" }))).toEqual({
      eligible: true,
      witness_event_id: "e1",
    });
  });

  test("a shape mismatch reads as null, same as a failed request", () => {
    expect(recallEligibilityOf(ok({ eligible: "yes" }))).toBeNull();
    expect(recallEligibilityOf(failed())).toBeNull();
  });
});

// ── fix-round additions (#33 R12) ────────────────────────────────────────────

describe("associationsOf (direct evidence)", () => {
  test("a resolved revision's terms and links are returned as-is", () => {
    const row = {
      workspace_name: "w",
      node_id: "n1",
      revision_id: "r1",
      content_digest: "d1",
      snapshot_head_revision_id: "r1",
      is_snapshot_head: true,
      terms: [{ term_id: "t1" }],
      links: [{ position: "0" }],
    };
    expect(associationsOf(ok(row))).toEqual(row);
  });

  test("null is an ANSWER (node/revision not on accepted ancestry), not an error", () => {
    expect(associationsOf(ok(null))).toBeNull();
  });

  test("a failed request reads as null", () => {
    expect(associationsOf(failed())).toBeNull();
  });
});

describe("dependentsOf (reverse evidence)", () => {
  test("a page reads its occurrences and next_cursor", () => {
    const cursor = { node_id: "n9", revision_no: "3", position: "1" };
    const page = dependentsOf(
      ok({ outcome: "page", nodes_version: "4", occurrences: [{ node_id: "n2" }], next_cursor: cursor }),
    );
    expect(page).toEqual({ outcome: "page", occurrences: [{ node_id: "n2" }], nextCursor: cursor });
  });

  test("an exhausted page has a null cursor, not an omitted one", () => {
    const page = dependentsOf(ok({ outcome: "page", nodes_version: "4", occurrences: [], next_cursor: null }));
    expect(page.nextCursor).toBeNull();
  });

  test("restart_required is its own outcome, not folded into an empty page", () => {
    const page = dependentsOf(ok({ outcome: "restart_required" }));
    expect(page).toEqual({ outcome: "restart_required", occurrences: [], nextCursor: null });
  });

  test("a failed request reads as an error outcome, not a silent empty page", () => {
    expect(dependentsOf(failed())).toEqual({ outcome: "error", occurrences: [], nextCursor: null });
  });
});

describe("lifecycleWriteOutcomeOf", () => {
  test("accepted and idempotent are read verbatim", () => {
    expect(lifecycleWriteOutcomeOf(ok({ outcome: "accepted" }))).toEqual({ outcome: "accepted" });
    expect(lifecycleWriteOutcomeOf(ok({ outcome: "idempotent" }))).toEqual({ outcome: "idempotent" });
  });

  test("conflict carries its reason", () => {
    expect(lifecycleWriteOutcomeOf(ok({ outcome: "conflict", reason: "stale_pin" }))).toEqual({
      outcome: "conflict",
      reason: "stale_pin",
    });
  });

  test("a failed request or malformed body reads as null, not a thrown shape mismatch", () => {
    expect(lifecycleWriteOutcomeOf(failed())).toBeNull();
    expect(lifecycleWriteOutcomeOf(ok({ outcome: "conflict" }))).toBeNull();
    expect(lifecycleWriteOutcomeOf(ok({}))).toBeNull();
  });
});
