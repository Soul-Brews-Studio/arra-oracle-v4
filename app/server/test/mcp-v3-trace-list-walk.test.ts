// V7 fix round (docs/overnight/V3-PARITY.md §4.4, §5; overnight R18): the
// `oracle_trace_list` walk over K5's `listTraces` must never copy a null
// cursor back into the next request. Written BEFORE the guard existed --
// RED on `oracle_trace_list.ts` at slice HEAD (61dd298): a stubbed kernel
// that legitimately answers `has_more:true` with no cursor (the exact shape
// K5's own dead-end bug produced past its 1000-row scan window) made the old
// walk restart from the newest trace and return the first page's row a
// second time.
//
// Unit-level and deterministic, no real gate or dataset: the kernel is a
// hand-scripted stub keyed on the request's own cursor, so this isolates the
// ADAPTER's contract (never trust a `has_more:true` with a null cursor)
// independently of whether the K5 kernel itself is currently fixed. The real
// kernel's own cursor semantics are covered by `trace-list-cursor.test.ts`.

import { describe, expect, test } from "bun:test";
import { oracle_trace_list } from "../src/mcp/legacy-v3/tools/oracle_trace_list";
import type { V3ToolContext } from "../src/mcp/legacy-v3/handlers";

const row = (id: string, created_at: string) => ({
  id,
  query: `row ${id}`,
  depth: "0",
  derived_from_count: 0,
  created_at,
});

/** A `V3ToolContext` with everything but `kb` set to an inert placeholder --
 *  `oracle_trace_list` reads only `context.kb`. */
const fakeContext = (kb: V3ToolContext["kb"]): V3ToolContext => ({
  tool: "oracle_trace_list",
  bank: "ws-stub",
  kb,
  assertedPeer: null,
  authority: {} as V3ToolContext["authority"],
  indexProfile: {} as V3ToolContext["indexProfile"],
});

describe("oracle_trace_list walk: never restarts on a null-cursor has_more:true (V7 fix round)", () => {
  test("a kernel dead end (has_more:true, no cursor) stops the walk instead of replaying the first page", async () => {
    const rowA = row("bulkA00000000000000000", "2026-01-01T00:00:00.000Z");
    let calls = 0;
    const kb: V3ToolContext["kb"] = async (method, payload) => {
      calls += 1;
      expect(method).toBe("listTraces");
      const p = payload as { after_created_at: string | null; after_id: string | null };
      if (p.after_created_at === null && p.after_id === null) {
        // Page 0: one match, a valid cursor to move past it.
        return {
          rows: [rowA],
          next_after_created_at: "2026-01-01T00:00:00.000Z",
          next_after_id: rowA.id,
          has_more: true,
        };
      }
      if (p.after_created_at === "2026-01-01T00:00:00.000Z" && p.after_id === rowA.id) {
        // Page 1: the exact K5 dead end -- more claimed, no cursor to reach it.
        return { rows: [], next_after_created_at: null, next_after_id: null, has_more: true };
      }
      // A restart would call back with a null cursor a SECOND time; fail
      // loudly rather than silently hand back page 0's row again.
      throw new Error(`unexpected re-call with cursor ${JSON.stringify(p)} (call #${calls}) -- the walk restarted`);
    };

    const result = (await oracle_trace_list({ limit: 20 }, fakeContext(kb))) as {
      traces: { trace_id: string }[];
      has_more: boolean;
    };

    expect(calls).toBe(2);
    expect(result.traces.map((t) => t.trace_id)).toEqual([rowA.id]);
    // Honest "might be more" (the dead end was never proven exhaustive),
    // never a page presented as complete.
    expect(result.has_more).toBe(true);
  });

  test("happy path across two real pages still concatenates cleanly (no regression)", async () => {
    const rowA = row("bulkB00000000000000000", "2026-01-01T00:00:00.000Z");
    const rowB = row("bulkC00000000000000000", "2025-12-31T00:00:00.000Z");
    const kb: V3ToolContext["kb"] = async (_method, payload) => {
      const p = payload as { after_created_at: string | null; after_id: string | null };
      if (p.after_created_at === null && p.after_id === null) {
        return { rows: [rowA], next_after_created_at: "2026-01-01T00:00:00.000Z", next_after_id: rowA.id, has_more: true };
      }
      return { rows: [rowB], next_after_created_at: null, next_after_id: null, has_more: false };
    };

    const result = (await oracle_trace_list({ limit: 20 }, fakeContext(kb))) as {
      traces: { trace_id: string }[];
      has_more: boolean;
    };

    expect(result.traces.map((t) => t.trace_id)).toEqual([rowA.id, rowB.id]);
    expect(result.has_more).toBe(false);
  });
});
