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
