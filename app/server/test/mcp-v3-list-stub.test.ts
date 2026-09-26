// R18 D3 fix round (v3-list slice): adapter-level behaviour of the V6 recall
// tools, driven with a STUB `kb` -- no dataset, no gate, no model. The
// end-to-end proof that recall tools drop ineligible nodes is
// mcp-v3-list-eligibility.test.ts; this file pins what is awkward to reach
// through a real dataset:
//   - every recall-path listNodes request asks for the kernel's recall view
//     (`eligible_only: true`), never the default view;
//   - oracle_reflect follows `next_after_id` past scan windows that held no
//     match, instead of answering no_results for a sparse pool;
//   - oracle_recap's character budget covers its own footer, and its default
//     limit is v3's 8.

import { describe, expect, test } from "bun:test";
import type { V3ToolContext } from "../src/mcp/legacy-v3/handlers";
import { oracle_recap } from "../src/mcp/legacy-v3/tools/oracle_recap";
import { oracle_reflect } from "../src/mcp/legacy-v3/tools/oracle_reflect";

type Call = { method: string; payload: Record<string, any> };

const LEARNING_SNAPSHOT = JSON.stringify([{ vocabulary_name_snapshot: "type", term_name_snapshot: "learning" }]);
const nodeId = (n: number) => `stubnode${String(n).padStart(13, "0")}`;

function contextWith(kb: (method: string, payload: Record<string, any>) => unknown, calls: Call[]): V3ToolContext {
  return {
    tool: "stub",
    bank: "stub-bank",
    kb: async (method, payload) => {
      calls.push({ method, payload: structuredClone(payload) as Record<string, any> });
      return kb(method, payload as Record<string, any>);
    },
    assertedPeer: null,
    authority: {} as V3ToolContext["authority"],
    indexProfile: {} as V3ToolContext["indexProfile"],
  };
}

describe("oracle_reflect (stub kb)", () => {
  test("a sparse pool: scan windows with no match are followed via next_after_id, and every draw asks for eligible_only", async () => {
    const calls: Call[] = [];
    const TARGET = nodeId(1);
    // Simulates a bank whose only eligible learning sits several full scan
    // windows past both the random start and the wrap-around start.
    const kb = (method: string, payload: Record<string, any>) => {
      if (method === "lookupVocabularyByName") return null; // no legacy_type vocabulary: no principle pool
      if (method === "getAcceptedHead") return { revision: { body: "the one", term_snapshot_json: LEARNING_SNAPSHOT } };
      if (method !== "listNodes") throw new Error(`unexpected ${method}`);
      const after = payload.after_id as string | null;
      if (after === "window-3") return { rows: [{ id: TARGET }], next_after_id: null, next_after_updated_at: null, total: null };
      if (after === "window-2") return { rows: [], next_after_id: "window-3", next_after_updated_at: null, total: null };
      if (after === "window-1") return { rows: [], next_after_id: "window-2", next_after_updated_at: null, total: null };
      if (after === null) return { rows: [], next_after_id: "window-1", next_after_updated_at: null, total: null };
      // The random start: a full window with no match, and the end of the id space.
      return { rows: [], next_after_id: null, next_after_updated_at: null, total: null };
    };
    const result = (await oracle_reflect({}, contextWith(kb, calls))) as { principle: { id: string } };
    expect(result.principle.id).toBe(TARGET);
    const lists = calls.filter((c) => c.method === "listNodes");
    expect(lists.length).toBeGreaterThanOrEqual(4);
    for (const call of lists) expect(call.payload.eligible_only).toBe(true);
  });

  test("a truly empty eligible pool still answers no_results, after a bounded walk", async () => {
    const calls: Call[] = [];
    let n = 0;
    const kb = (method: string) => {
      if (method === "lookupVocabularyByName") return null;
      if (method !== "listNodes") throw new Error(`unexpected ${method}`);
      n += 1;
      // Never a match, never the end: the walk must stop on its own bound.
      return { rows: [], next_after_id: nodeId(n), next_after_updated_at: null, total: null };
    };
    let caught: any = null;
    try {
      await oracle_reflect({}, contextWith(kb, calls));
    } catch (error) {
      caught = error;
    }
    expect(caught?.code ?? caught?.compat?.code ?? JSON.stringify(caught)).toContain("no_results");
    expect(calls.filter((c) => c.method === "listNodes").length).toBeLessThanOrEqual(40);
  });
});

describe("oracle_recap (stub kb)", () => {
  const recapKb = (count: number, title: (i: number) => string) => (method: string, payload: Record<string, any>) => {
    if (method === "listNodes") {
      const rows = Array.from({ length: Math.min(count, payload.limit as number) }, (_, i) => ({ id: nodeId(i) }));
      return { rows, next_after_id: null, next_after_updated_at: null, total: null };
    }
    if (method === "getAcceptedHead") {
      const i = Number(String(payload.node_id).slice(8));
      return { revision: { title: title(i), body: "body", term_snapshot_json: LEARNING_SNAPSHOT } };
    }
    throw new Error(`unexpected ${method}`);
  };

  test("listNodes is asked for the recall view, newest first, with v3's default limit of 8", async () => {
    const calls: Call[] = [];
    await oracle_recap({}, contextWith(recapKb(3, (i) => `t${i}`), calls));
    const list = calls.find((c) => c.method === "listNodes")!;
    expect(list.payload).toMatchObject({ eligible_only: true, order: "updated_desc", limit: 8 });
  });

  test("the character budget covers the footer too: a truncated recap stays within 8000 characters", async () => {
    const calls: Call[] = [];
    const text = await oracle_recap({ limit: 100 }, contextWith(recapKb(100, (i) => `${"x".repeat(150)} ${i}`), calls));
    expect(text).toContain("_compat(truncated)");
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  test("a title's newlines collapse to spaces, so it cannot open a heading", async () => {
    const calls: Call[] = [];
    const text = await oracle_recap({}, contextWith(recapKb(1, () => "ok\n## injected\n\n- fake"), calls));
    expect(text).not.toMatch(/^## injected/m);
    expect(text).not.toMatch(/^- fake/m);
    expect(text).toContain("ok ## injected - fake");
  });
});
