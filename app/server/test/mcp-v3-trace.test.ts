// Slice V3 -- oracle_trace, oracle_trace_get, oracle_trace_chain,
// oracle_trace_distill (docs/overnight/V3-PARITY.md §4.2/§4.3, §7 "V3"
// failing-first list; DECISIONS.md R18 D4) -- plus K5 (listTraces) and its
// V7 upgrades to oracle_trace_get (child_trace_ids/next_trace_id) and
// oracle_trace_chain (forward walking). Written BEFORE the five tools/K5
// existed; ALL steps below were red on the base this slice branched from.
//
// Real gate, real dataset, real wire, reusing `fixtures/v3-compat-v1/core/
// writes-child.ts` (V1's gated child): it boots the production app inside
// `exec_with_gate` and replays scripted MCP calls generically over
// `{facade, tool, args}` -- no trace-specific child script is needed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, runGated, type Fixture } from "./helpers/publication-fixture";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "writes-child.ts");
const WS = "ws-trace";
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const BOGUS_PARENT = pad("nosuchtraceatall");
const V3_UUID = "3264052e-e8d4-4a64-a255-8e72b0e0979b";

let fixture: Fixture;
let work: string;
let out: Record<string, any> = {};

async function runChild(steps: unknown[]) {
  const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, work, JSON.stringify({ banks: [WS], steps })], {
    deadlineMs: 180_000,
    env: { ARRA_DATA_DIR: join(work, "legacy"), ARRA_KNOWLEDGE_DATASET_ROOT: fixture.datasetRoot },
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (result.code !== 0 || line === undefined) throw new Error(`writes-child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  return JSON.parse(line);
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arra-v3-trace-"));
  await mkdir(join(work, "legacy"));
  fixture = await createFixture([WS]);

  out = await runChild([
    // 1. A real-shaped trace: 2 files, one full-length (40-hex) commit, one
    //    short (7-hex, unrepresentable) commit, one issue with no url.
    {
      label: "t1", bank: WS, tool: "oracle_trace",
      args: {
        query: "arthur firmware digital-twin repo split",
        project: "github.com/laris-co/example-fw",
        queryType: "project",
        agentCount: 2,
        foundFiles: [{ path: "a.ts", type: "other", confidence: "high" }, { path: "b.ts", type: "other", confidence: "low" }],
        foundCommits: [
          { hash: "a".repeat(40), shortHash: "aaaaaaa", message: "full length", date: "2026-02-22" },
          { hash: "cebbca8", shortHash: "cebbca8", message: "short only", date: "2026-02-21" },
        ],
        foundIssues: [{ number: 42, title: "Split the digital-twin repo", state: "open" }],
      },
      capture: { name: "T1", path: ["trace_id"] },
    },
    // 2. A child by parentTraceId: depth 1.
    { label: "t1b", bank: WS, tool: "oracle_trace", args: { query: "child of t1", parentTraceId: { $ref: "T1" } }, capture: { name: "T1B", path: ["trace_id"] } },
    // 3. An unknown (but well-formed) parent is now an error (v3 dropped it silently).
    { label: "bad_parent", bank: WS, tool: "oracle_trace", args: { query: "orphan", parentTraceId: BOGUS_PARENT } },
    // 4. idempotency_key replays the same trace_id.
    { label: "idem_1", bank: WS, tool: "oracle_trace", args: { query: "retried trace", idempotency_key: "trace-k-1" }, capture: { name: "IDEM", path: ["trace_id"] } },
    { label: "idem_2", bank: WS, tool: "oracle_trace", args: { query: "retried trace", idempotency_key: "trace-k-1" } },
    // A blank query is refused.
    { label: "blank_query", bank: WS, tool: "oracle_trace", args: { query: "   " } },

    // 5. trace_get round-trips found_* and refuses a v3 UUID.
    { label: "get_t1", bank: WS, tool: "oracle_trace_get", args: { traceId: { $ref: "T1" } } },
    { label: "get_t1_chain", bank: WS, tool: "oracle_trace_get", args: { traceId: { $ref: "T1" }, includeChain: true } },
    { label: "get_uuid", bank: WS, tool: "oracle_trace_get", args: { traceId: V3_UUID } },

    // 6. Chain: A -> B (prevTraceId=A); backward from B sees [A,B]; a second
    //    successor of A forks the forward walk.
    { label: "chain_a", bank: WS, tool: "oracle_trace", args: { query: "chain root" }, capture: { name: "A", path: ["trace_id"] } },
    { label: "chain_b", bank: WS, tool: "oracle_trace", args: { query: "chain step 2", prevTraceId: { $ref: "A" } }, capture: { name: "B", path: ["trace_id"] } },
    { label: "chain_from_b", bank: WS, tool: "oracle_trace_chain", args: { traceId: { $ref: "B" } } },
    { label: "chain_c_fork", bank: WS, tool: "oracle_trace", args: { query: "chain fork", prevTraceId: { $ref: "A" } }, capture: { name: "C", path: ["trace_id"] } },
    { label: "chain_from_a_forked", bank: WS, tool: "oracle_trace_chain", args: { traceId: { $ref: "A" } } },
    { label: "chain_unknown", bank: WS, tool: "oracle_trace_chain", args: { traceId: pad("unknownchainstart") } },
    { label: "chain_uuid", bank: WS, tool: "oracle_trace_chain", args: { traceId: V3_UUID } },

    // 7. Distill: promoted -> learning; not promoted -> conclusion;
    //    re-distill adds a SECOND node; the trace row is never rewritten.
    { label: "get_t1_before_distill", bank: WS, tool: "oracle_trace_get", args: { traceId: { $ref: "T1" } } },
    { label: "distill_promoted", bank: WS, tool: "oracle_trace_distill", args: { traceId: { $ref: "T1" }, awakening: "The flasher lives with firmware, not the demo.", promoteToLearning: true, concepts: ["firmware"] }, capture: { name: "D1", path: ["learningId"] } },
    { label: "distill_conclusion", bank: WS, tool: "oracle_trace_distill", args: { traceId: { $ref: "T1" }, awakening: "A second, unpromoted conclusion.", promoteToLearning: false } },
    { label: "distill_again", bank: WS, tool: "oracle_trace_distill", args: { traceId: { $ref: "T1" }, awakening: "Distilled a second time on purpose.", promoteToLearning: true }, capture: { name: "D2", path: ["learningId"] } },
    { label: "get_t1_after_distill", bank: WS, tool: "oracle_trace_get", args: { traceId: { $ref: "T1" } } },

    // 8/9. trace_list (K5/V7): newest-first, status filter, child_trace_ids.
    { label: "list_all", bank: WS, tool: "oracle_trace_list", args: { limit: 50 } },
    { label: "list_distilled", bank: WS, tool: "oracle_trace_list", args: { status: "distilled", limit: 50 } },
    { label: "list_raw", bank: WS, tool: "oracle_trace_list", args: { status: "raw", limit: 50 } },
    { label: "list_reviewed", bank: WS, tool: "oracle_trace_list", args: { status: "reviewed", limit: 50 } },
    { label: "get_t1_children", bank: WS, tool: "oracle_trace_get", args: { traceId: { $ref: "T1" } } },
  ]);
}, 300_000);

afterAll(async () => {
  await fixture?.cleanup();
  if (work) await rm(work, { recursive: true, force: true });
});

describe("oracle_trace (V3 #1, #2, #3, #4)", () => {
  test("writes commit and issue hits only; files stay in metadata; summary matches v3's raw counts", () => {
    const res = out.t1;
    expect(res.isError).toBe(false);
    expect(res.value).toMatchObject({ success: true, depth: 0 });
    expect(res.value.trace_id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(res.value.summary).toEqual({ file_count: 2, commit_count: 2, issue_count: 1, total_dig_points: 5 });
  });

  test("a parent gives depth 1", () => {
    expect(out.t1b.isError).toBe(false);
    expect(out.t1b.value.depth).toBe(1);
  });

  test("an unknown (well-formed) parent is an error, not v3's silent drop", () => {
    expect(out.bad_parent.isError).toBe(true);
    expect(out.bad_parent.value.compat.code).toBe("kernel_error");
  });

  test("idempotency_key replays to the same trace_id", () => {
    expect(out.idem_1.isError).toBe(false);
    expect(out.idem_2.isError).toBe(false);
    expect(out.idem_2.value.trace_id).toBe(out.idem_1.value.trace_id);
  });

  test("a blank query is refused", () => {
    expect(out.blank_query.isError).toBe(true);
    expect(out.blank_query.value.compat.code).toBe("unsupported_argument");
  });
});

describe("oracle_trace_get (V3 #5)", () => {
  test("round-trips found_commits/found_issues: the full-length commit and the issue are indexed hits; the short commit is unrepresentable", () => {
    const value = out.get_t1.value;
    expect(out.get_t1.isError).toBe(false);
    expect(value.file_count).toBe(2);
    expect(value.commit_count).toBe(2);
    expect(value.issue_count).toBe(1);
    expect(value.found_commits).toHaveLength(2);
    expect(value.found_commits[0]).toMatchObject({ hash: "a".repeat(40), message: "full length" });
    // The short hash never round-trips as a fabricated full hash.
    expect(value.found_commits.some((c: any) => c.hash === "cebbca8")).toBe(true);
    expect(value.found_issues).toHaveLength(1);
    expect(value.found_issues[0]).toMatchObject({ number: 42, title: "Split the digital-twin repo" });
    expect(typeof value.found_issues[0].url).toBe("string");
  });

  test("includeChain returns a chain object without throwing", () => {
    expect(out.get_t1_chain.isError).toBe(false);
    expect(out.get_t1_chain.value.chain).toBeTruthy();
    expect(Array.isArray(out.get_t1_chain.value.chain.traces)).toBe(true);
  });

  test("a v3 UUID is legacy_id_unknown, never a lookup attempt", () => {
    expect(out.get_uuid.isError).toBe(true);
    expect(out.get_uuid.value.compat.code).toBe("legacy_id_unknown");
  });
});

describe("oracle_trace_chain (V3 #6, V7 forward)", () => {
  test("backward walks prev_id to the start", () => {
    expect(out.chain_from_b.isError).toBe(false);
    expect(out.chain_from_b.value.chain.map((c: any) => c.trace_id)).toEqual([out.chain_a.value.trace_id, out.chain_b.value.trace_id]);
    expect(out.chain_from_b.value.position).toBe(1);
    expect(out.chain_from_b.value.chain_length).toBe(2);
  });

  test("a fork stops the forward walk and reports both branches", () => {
    expect(out.chain_from_a_forked.isError).toBe(false);
    expect(out.chain_from_a_forked.value.forked).toBe(true);
    expect(out.chain_from_a_forked.value.branches.sort()).toEqual([out.chain_b.value.trace_id, out.chain_c_fork.value.trace_id].sort());
  });

  test("an unknown but well-formed start is v3's own empty chain, not an error", () => {
    expect(out.chain_unknown.isError).toBe(false);
    expect(out.chain_unknown.value).toEqual({ chain: [], position: 0, chain_length: 0 });
  });

  test("a v3 UUID start is legacy_id_unknown", () => {
    expect(out.chain_uuid.isError).toBe(true);
    expect(out.chain_uuid.value.compat.code).toBe("legacy_id_unknown");
  });
});

describe("oracle_trace_distill (V3 #7, R18 D4)", () => {
  test("promoted publishes type learning, derived_from the trace", () => {
    expect(out.distill_promoted.isError).toBe(false);
    expect(out.distill_promoted.value).toMatchObject({ success: true, status: "distilled" });
    expect(typeof out.distill_promoted.value.learningId).toBe("string");
  });

  test("not promoted publishes type conclusion, with no learningId", () => {
    expect(out.distill_conclusion.isError).toBe(false);
    expect(out.distill_conclusion.value).toEqual({ success: true, status: "distilled" });
  });

  test("re-distilling adds a SECOND node, never replacing the first", () => {
    expect(out.distill_again.isError).toBe(false);
    expect(out.distill_again.value.learningId).not.toBe(out.distill_promoted.value.learningId);
  });

  test("the trace row itself is byte-identical before and after every distill", () => {
    const before = out.get_t1_before_distill.value;
    const after = out.get_t1_after_distill.value;
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.query).toBe(before.query);
  });

  test("oracle_trace_get now reports status distilled, naming all three distillations (promoted, conclusion, and the re-distill)", () => {
    const after = out.get_t1_after_distill.value;
    expect(after.status).toBe("distilled");
    expect(after.distilled_to_ids).toHaveLength(3);
    expect(after.distilled_to_ids).toEqual(expect.arrayContaining([out.distill_promoted.value.learningId, out.distill_again.value.learningId]));
    expect(typeof after.awakening).toBe("string");
  });
});

describe("oracle_trace_list (K5, V7)", () => {
  test("lists newest first and includes T1", () => {
    expect(out.list_all.isError).toBe(false);
    const ids = out.list_all.value.traces.map((t: any) => t.trace_id);
    expect(ids).toContain(out.t1.value.trace_id);
    const createdAts = out.list_all.value.traces.map((t: any) => Date.parse(t.created_at));
    expect(createdAts).toEqual([...createdAts].sort((a, b) => b - a));
  });

  test("status:distilled includes T1 (has_awakening true); status:raw excludes it", () => {
    const distilledIds = out.list_distilled.value.traces.map((t: any) => t.trace_id);
    const rawIds = out.list_raw.value.traces.map((t: any) => t.trace_id);
    expect(distilledIds).toContain(out.t1.value.trace_id);
    expect(rawIds).not.toContain(out.t1.value.trace_id);
    const t1Row = out.list_distilled.value.traces.find((t: any) => t.trace_id === out.t1.value.trace_id);
    expect(t1Row.has_awakening).toBe(true);
    expect(t1Row.status).toBe("distilled");
  });

  test("status:reviewed is semantic_refusal: an immutable trace has no review state", () => {
    expect(out.list_reviewed.isError).toBe(true);
    expect(out.list_reviewed.value.compat.code).toBe("semantic_refusal");
  });
});

describe("oracle_trace_get children (V7, K5)", () => {
  test("child_trace_ids includes the parentTraceId child", () => {
    expect(out.get_t1_children.value.child_trace_ids).toContain(out.t1b.value.trace_id);
  });
});
