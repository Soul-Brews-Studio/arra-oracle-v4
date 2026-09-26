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

const row = (id: string, created_at: string, h_metadata: string | null = null) => ({
  id,
  query: `row ${id}`,
  depth: "0",
  derived_from_count: 0,
  h_metadata,
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

// Fix round 2 (overnight R18): v3's `project` and `depth` filters (v3
// src/trace/list.ts:17-19) were silently dropped, and a walk that ran out of
// budget said nothing about it. Unit level against a stubbed kernel, as above.
describe("oracle_trace_list filters and walk budget (V7 fix round 2)", () => {
  const meta = (project: string | null) => JSON.stringify({ project, query_type: null, scope: null, agent_count: null, duration_ms: null, legacy: {} });

  test("depth goes to the kernel as int64 decimal text; absent depth goes as null", async () => {
    const seen: unknown[] = [];
    const kb: V3ToolContext["kb"] = async (_method, payload) => {
      seen.push((payload as { depth: unknown }).depth);
      return { rows: [], next_after_created_at: null, next_after_id: null, has_more: false };
    };
    await oracle_trace_list({ depth: 3 }, fakeContext(kb));
    await oracle_trace_list({}, fakeContext(kb));
    expect(seen).toEqual(["3", null]);
  });

  test("project keeps only traces whose recorded h_metadata.project is exactly that project", async () => {
    const kb: V3ToolContext["kb"] = async () => ({
      rows: [
        row("projA000000000000000a", "2026-01-03T00:00:00.000Z", meta("github.com/o/r")),
        row("projB000000000000000b", "2026-01-02T00:00:00.000Z", meta("github.com/o/other")),
        row("projC000000000000000c", "2026-01-01T00:00:00.000Z", null),
        row("projD000000000000000d", "2025-12-31T00:00:00.000Z", "not json at all"),
      ],
      next_after_created_at: null, next_after_id: null, has_more: false,
    });
    const result = (await oracle_trace_list({ project: "github.com/o/r" }, fakeContext(kb))) as { traces: { trace_id: string }[]; has_more: boolean };
    expect(result.traces.map((t) => t.trace_id)).toEqual(["projA000000000000000a"]);
    expect(result.has_more).toBe(false);
  });

  test("a walk that runs out of budget before the predicate is exhausted says truncated, never a silent short page", async () => {
    let calls = 0;
    const kb: V3ToolContext["kb"] = async () => {
      calls += 1;
      const id = `miss${String(calls).padStart(17, "0")}`;
      return { rows: [row(id, "2026-01-01T00:00:00.000Z", meta("github.com/o/other"))], next_after_created_at: "2026-01-01T00:00:00.000Z", next_after_id: id, has_more: true };
    };
    const result = (await oracle_trace_list({ project: "github.com/o/r" }, fakeContext(kb))) as {
      traces: unknown[]; has_more: boolean; compat_warnings: { code: string; field: string }[];
    };
    expect(result.traces).toEqual([]);
    expect(result.has_more).toBe(true);
    expect(result.compat_warnings).toContainEqual(expect.objectContaining({ code: "truncated", field: "traces" }));
  });

  test("an offset past the walk's reach is an empty page that says truncated, not a silent end", async () => {
    let calls = 0;
    const kb: V3ToolContext["kb"] = async () => {
      calls += 1;
      const rows = Array.from({ length: 100 }, (_, i) => row(`off${String(calls * 1000 + i).padStart(18, "0")}`, "2026-01-01T00:00:00.000Z"));
      return { rows, next_after_created_at: "2026-01-01T00:00:00.000Z", next_after_id: rows.at(-1)!.id, has_more: true };
    };
    // v3 clamps offset at 10000 (src/trace/list.ts:13); 50000 behaves as that.
    const result = (await oracle_trace_list({ offset: 50_000 }, fakeContext(kb))) as {
      traces: unknown[]; has_more: boolean; compat_warnings: { code: string; field: string }[];
    };
    expect(calls).toBe(10);
    expect(result.traces).toEqual([]);
    expect(result.has_more).toBe(true);
    expect(result.compat_warnings).toContainEqual(expect.objectContaining({ code: "truncated", field: "traces" }));
  });
});
