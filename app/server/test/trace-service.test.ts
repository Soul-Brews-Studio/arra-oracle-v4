/**
 * #28 trace + trace_hit kernel -- ONE minimal smoke test, not an exhaustive
 * suite. It exists to prove the kernel WORKS end to end and, specifically,
 * that the ms-vs-micros unit trap documented in `../src/publication/trace.ts`
 * does not silently mis-scale a real write.
 */

import { describe, expect, test } from "bun:test";
import { runGated } from "./helpers/publication-fixture";
import { createTraceFixture, createTraceRequest, hitInput, traceId } from "./helpers/trace-fixture";
import { parseCreateTrace } from "../src/publication/trace";
import { ContractError } from "../src/contracts/errors";

describe("real persistence: trace + trace_hit inside the real gate", () => {
  const CHILD = new URL("./fixtures/trace-v1/core/gated-trace.ts", import.meta.url).pathname;
  const ALPHA = "alpha-workspace";
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
  const TRACE1 = traceId("trace1");

  const drive = async (
    root: string,
    ops: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
    return JSON.parse(line);
  };
  const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
  const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

  test("create with two hits, read both back, exact ms/micros round trip, then replay is already_satisfied", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      // A sub-millisecond-precise wire timestamp for the hit: exercises the
      // MICROSECOND column (`captured_at`), distinct from the trace row's own
      // MILLISECOND columns.
      const capturedAt = "2026-09-21T00:00:00.123Z";

      const request = createTraceRequest(ALPHA, {
        id: TRACE1,
        hits: [
          hitInput({ ref: "hit-0", kind: "url", target: { url: "https://example.com/a" } }),
          hitInput({
            ref: "hit-1",
            kind: "code",
            target: {
              repo: "owner/repo",
              commit: { algorithm: "sha1", oid: "a".repeat(40) },
              path: "src/index.ts",
              line_start: "1",
              line_end: "2",
            },
            line_start: "10",
            line_end: "12",
            captured_at: capturedAt,
          }),
        ],
      });

      const parsed = await drive(fixture.datasetRoot, [
        ctx("createTrace", request),
        ctx("getTrace", { workspace_name: ALPHA, id: TRACE1 }),
        ctx("listTraceHits", { workspace_name: ALPHA, trace_id: TRACE1, after_position: null, limit: 10 }),
        // Same id, IDENTICAL payload: must replay, not conflict, not re-sample the clock.
        ctx("createTrace", request),
      ]);

      const created = parsed.op0;
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.value.outcome).toBe("created");
      expect(Object.keys(created.value.row).sort()).toEqual(
        [
          "id", "name", "workspace_name", "session_name", "peer_name", "query", "mode",
          "session_id", "session_from_ts", "session_to_ts", "friction_score", "confidence",
          "parent_id", "prev_id", "depth", "status", "h_metadata", "internal_metadata",
          "created_at", "updated_at",
        ].sort(),
      );

      // THE highest-value assertion: created_at is the clock value rendered
      // as MILLISECONDS, not multiplied by 1000 and rendered as if it were
      // micros. A 1000x scale bug would either produce a wildly different
      // date here or throw integrity_failure entirely (year > 9999).
      const expectedCreatedAt = new Date(CLOCK).toISOString();
      expect(created.value.row.created_at).toBe(expectedCreatedAt);
      // Immutable on a fresh write: updated_at === created_at exactly.
      expect(created.value.row.updated_at).toBe(created.value.row.created_at);

      expect(created.value.hits).toHaveLength(2);
      // The MICROSECOND column round-trips its sub-millisecond-capable wire
      // text EXACTLY, through the OPPOSITE unit than the trace row above.
      expect(created.value.hits[1].captured_at).toBe(capturedAt);
      expect(created.value.hits[0].captured_at).toBeNull();
      expect(created.value.hits.map((h: any) => h.position)).toEqual(["0", "1"]);
      expect(created.value.hits[1].line_start).toBe("10");
      expect(created.value.hits[1].line_end).toBe("12");

      const readTrace = parsed.op1;
      expect(readTrace.ok, JSON.stringify(readTrace)).toBe(true);
      expect(readTrace.value).toEqual(created.value.row);

      const readHits = parsed.op2;
      expect(readHits.ok, JSON.stringify(readHits)).toBe(true);
      expect(readHits.value.rows).toEqual(created.value.hits);
      expect(readHits.value.next_after_position).toBeNull();

      // Replay: same id, same payload -> already_satisfied, retained rows,
      // NO second clock sample (the clock is called exactly once, by the
      // first create; a replay that samples again would show up as 2 here).
      const replay = parsed.op3;
      expect(replay.ok, JSON.stringify(replay)).toBe(true);
      expect(replay.value.outcome).toBe("already_satisfied");
      expect(replay.value.row).toEqual(created.value.row);
      expect(replay.value.hits).toEqual(created.value.hits);
      expect(parsed.clockCalls).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a different payload under the SAME id conflicts, not overwrites", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const first = createTraceRequest(ALPHA, { id: TRACE1, hits: [hitInput({ ref: "hit-0" })] });
      const second = createTraceRequest(ALPHA, { id: TRACE1, name: "trace-b", hits: [hitInput({ ref: "hit-0" })] });
      const parsed = await drive(fixture.datasetRoot, [ctx("createTrace", first), ctx("createTrace", second)]);
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.op0.value.outcome).toBe("created");
      expect(parsed.op1.ok).toBe(true);
      expect(parsed.op1.value.outcome).toBe("conflict");
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("TR-1: a year-0000 captured_at is refused at its field pointer, writes nothing, and does NOT poison the owner", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const bad = createTraceRequest(ALPHA, {
        id: TRACE1,
        hits: [hitInput({ ref: "hit-0", captured_at: "0000-06-15T12:00:00.000Z" })],
      });
      const good = createTraceRequest(ALPHA, { id: traceId("trace2"), hits: [] });
      const parsed = await drive(fixture.datasetRoot, [
        ctx("createTrace", bad),
        // The owner must still be USABLE afterwards: a poisoned owner would
        // fail this with recovery_required regardless of payload.
        ctx("createTrace", good),
        ctx("getTrace", { workspace_name: ALPHA, id: TRACE1 }),
      ]);

      const rejected = parsed.op0;
      expect(rejected.ok, JSON.stringify(rejected)).toBe(false);
      expect(rejected.code).toBe("invalid_value");
      expect(rejected.path).toBe("/hits/0/captured_at");

      const stillWorks = parsed.op1;
      expect(stillWorks.ok, JSON.stringify(stillWorks)).toBe(true);
      expect(stillWorks.value.outcome).toBe("created");

      // No orphan trace row: the rejected request wrote NOTHING.
      expect(parsed.op2.value).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("TR-3: a non-contiguous stored position is refused on the read path", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const request = createTraceRequest(ALPHA, { id: TRACE1, hits: [hitInput({ ref: "hit-0" })] });
      const parsed = await drive(fixture.datasetRoot, [
        ctx("createTrace", request),
        // Plant a SECOND hit at position 5: the real write path can never
        // produce this gap, so this is the only way to reach it.
        hx("insertRawHit", {
          workspace_name: ALPHA,
          trace_id: TRACE1,
          kind: "url",
          ref: "hit-gap",
          target: '{"url":"https://example.com/gap"}',
          position: 5,
        }),
        ctx("listTraceHits", { workspace_name: ALPHA, trace_id: TRACE1, after_position: null, limit: 10 }),
      ]);
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.op1.ok).toBe(true);

      const listed = parsed.op2;
      expect(listed.ok, JSON.stringify(listed)).toBe(false);
      expect(listed.code).toBe("integrity_failure");
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("TR-2: a prefix-matching retry after a simulated ambiguous partial write recovers, not conflicts", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      // Simulate: an EARLIER attempt's trace row + first hit landed, then the
      // process died before the second hit's append. A fresh, unpoisoned
      // owner (e.g. after a restart) now receives the byte-identical retry.
      const partial = createTraceRequest(ALPHA, { id: TRACE1, hits: [hitInput({ ref: "hit-0" })] });
      const full = createTraceRequest(ALPHA, {
        id: TRACE1,
        hits: [hitInput({ ref: "hit-0" }), hitInput({ ref: "hit-1" })],
      });
      const parsed = await drive(fixture.datasetRoot, [ctx("createTrace", partial), ctx("createTrace", full)]);
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      expect(parsed.op0.value.outcome).toBe("created");

      const retry = parsed.op1;
      expect(retry.ok, JSON.stringify(retry)).toBe(false);
      expect(retry.code).toBe("recovery_required");
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("TR-4: a stored parent_id outside the nanoid21 namespace is refused on read", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        hx("insertRawTrace", { id: TRACE1, workspace_name: ALPHA, parent_id: "not-a-nanoid21-id" }),
        ctx("getTrace", { workspace_name: ALPHA, id: TRACE1 }),
      ]);
      expect(parsed.op0.ok).toBe(true);
      const read = parsed.op1;
      expect(read.ok, JSON.stringify(read)).toBe(false);
      expect(read.code).toBe("integrity_failure");
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("TR-7: a stored negative position is refused, distinctly from a mere gap", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const request = createTraceRequest(ALPHA, { id: TRACE1, hits: [hitInput({ ref: "hit-0" })] });
      const parsed = await drive(fixture.datasetRoot, [
        ctx("createTrace", request),
        // Plant a second hit at position -1: the real write path can only
        // ever assign `BigInt(i)` with `i >= 0`.
        hx("insertRawHit", {
          workspace_name: ALPHA,
          trace_id: TRACE1,
          kind: "url",
          ref: "hit-neg",
          target: '{"url":"https://example.com/neg"}',
          position: -1,
        }),
        // The replay comparison decodes EVERY stored hit (encodeTraceHitRow)
        // before its own contiguity loop runs, so the negative value is
        // caught by the stored-int64 guard, not the contiguity one.
        ctx(
          "createTrace",
          createTraceRequest(ALPHA, {
            id: TRACE1,
            hits: [hitInput({ ref: "hit-0" }), hitInput({ ref: "hit-1" })],
          }),
        ),
      ]);
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.op1.ok).toBe(true);
      const replay = parsed.op2;
      expect(replay.ok, JSON.stringify(replay)).toBe(false);
      expect(replay.code).toBe("integrity_failure");
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("TR-11: a stored empty-string nullable text column is refused, not served as legitimate", async () => {
    const fixture = await createTraceFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        // No real hit at all: a lone planted row at position 0 is
        // contiguous, isolating this from TR-3/TR-7's checks.
        hx("insertRawTrace", { id: TRACE1, workspace_name: ALPHA }),
        hx("insertRawHit", {
          workspace_name: ALPHA,
          trace_id: TRACE1,
          kind: "url",
          ref: "hit-0",
          target: '{"url":"https://example.com/a"}',
          note: "",
          position: 0,
        }),
        ctx("listTraceHits", { workspace_name: ALPHA, trace_id: TRACE1, after_position: null, limit: 10 }),
      ]);
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.op1.ok).toBe(true);
      const listed = parsed.op2;
      expect(listed.ok, JSON.stringify(listed)).toBe(false);
      expect(listed.code).toBe("integrity_failure");
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  describe("K13 (v3-parity hygiene review): depth must be parent.depth + 1, or 0 with no parent", () => {
    // .tmp/understand/analysis-28.json / docs/overnight/V3-PARITY.md K13:
    // "createTrace accepts any depth" -- measured, no check existed. A
    // caller could name ANY nonnegative depth regardless of the resolved
    // parent's own depth, or a nonzero depth with no parent at all.
    const ROOT = traceId("k13Root");
    const CHILD_OK = traceId("k13ChildOk");

    test("a root trace (no parent_id) with a nonzero depth is refused", async () => {
      const fixture = await createTraceFixture([ALPHA]);
      try {
        const parsed = await drive(fixture.datasetRoot, [
          ctx("createTrace", createTraceRequest(ALPHA, { id: ROOT, parent_id: null, depth: "5" })),
        ]);
        const attempt = parsed.op0;
        expect(attempt.ok).toBe(false);
        expect(attempt.code).toBe("invalid_request");
        expect(attempt.path).toBe("/depth");
      } finally {
        await fixture.cleanup();
      }
    }, 300_000);

    test("a child whose depth disagrees with parent.depth + 1 is refused", async () => {
      const fixture = await createTraceFixture([ALPHA]);
      try {
        const parsed = await drive(fixture.datasetRoot, [
          ctx("createTrace", createTraceRequest(ALPHA, { id: ROOT, parent_id: null, depth: "0" })),
          // The root's OWN depth is 0, so a child must be exactly 1 -- not 2,
          // not 0, not the root's own value.
          ctx("createTrace", createTraceRequest(ALPHA, {
            id: traceId("k13ChildBad"), parent_id: ROOT, depth: "2",
          })),
        ]);
        expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
        const attempt = parsed.op1;
        expect(attempt.ok).toBe(false);
        expect(attempt.code).toBe("invalid_request");
        expect(attempt.path).toBe("/depth");
      } finally {
        await fixture.cleanup();
      }
    }, 300_000);

    test("depth exactly one more than the resolved parent's depth is accepted", async () => {
      const fixture = await createTraceFixture([ALPHA]);
      try {
        const parsed = await drive(fixture.datasetRoot, [
          ctx("createTrace", createTraceRequest(ALPHA, { id: ROOT, parent_id: null, depth: "0" })),
          ctx("createTrace", createTraceRequest(ALPHA, { id: CHILD_OK, parent_id: ROOT, depth: "1" })),
          // A grandchild built on the CHILD's own depth (1), so its correct
          // depth is 2 -- proves the check reads the resolved parent's
          // actual stored depth, not merely "parent_id set => 1".
          ctx("createTrace", createTraceRequest(ALPHA, {
            id: traceId("k13Grandchild"), parent_id: CHILD_OK, depth: "2",
          })),
        ]);
        for (const op of [parsed.op0, parsed.op1, parsed.op2]) {
          expect(op.ok, JSON.stringify(op)).toBe(true);
          expect(op.value.outcome).toBe("created");
        }
      } finally {
        await fixture.cleanup();
      }
    }, 300_000);
  });
});

describe("the pure request grammar refuses a malformed target statically", () => {
  test("a hit citing an ill-formed trace target is refused before any write is attempted", () => {
    const request = createTraceRequest("alpha-workspace", {
      hits: [
        hitInput({
          ref: "hit-0",
          kind: "trace",
          // The `trace` target kind's ONLY key is `trace_id`, required
          // nonempty (evidence-v1.ts). An empty string names no trace at
          // all, so this is refused STATICALLY -- no dataset lookup, no
          // dereference, no network -- exactly the passive-locator posture
          // this kernel is required to keep.
          target: { trace_id: "" },
        }),
      ],
    });
    expect(() => parseCreateTrace(new TextEncoder().encode(JSON.stringify(request)))).toThrow(ContractError);
  });
});
