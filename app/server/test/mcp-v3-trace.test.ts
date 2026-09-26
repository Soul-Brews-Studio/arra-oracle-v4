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
import { openEvidenceReader } from "../src/publication/service";
import { V3_CATALOGUE } from "../src/mcp/legacy-v3/catalogue";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

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
    deadlineMs: scaledMs(180_000),
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

    // 6b (fix round, K5/V7 defect): R <- S1 <- S2, then an UNRELATED fork F
    // off R (upstream of S1/S2, not at S1 or S2 themselves -- the slice's own
    // "chain_from_a_forked" case above only ever asked about the fork point
    // itself, A, so it could not catch a fork sitting BETWEEN the requested
    // trace and the root). Backward from S2 already knows S2<-S1<-R
    // unambiguously (`prev_id` is single-valued); F must never cost S2 its
    // own position in its own chain.
    { label: "chain_r", bank: WS, tool: "oracle_trace", args: { query: "chain root r" }, capture: { name: "R", path: ["trace_id"] } },
    { label: "chain_s1", bank: WS, tool: "oracle_trace", args: { query: "chain step s1", prevTraceId: { $ref: "R" } }, capture: { name: "S1", path: ["trace_id"] } },
    { label: "chain_s2", bank: WS, tool: "oracle_trace", args: { query: "chain step s2", prevTraceId: { $ref: "S1" } }, capture: { name: "S2", path: ["trace_id"] } },
    { label: "chain_from_s2_before_fork", bank: WS, tool: "oracle_trace_chain", args: { traceId: { $ref: "S2" } } },
    { label: "chain_f_fork", bank: WS, tool: "oracle_trace", args: { query: "chain fork upstream of s2", prevTraceId: { $ref: "R" } }, capture: { name: "F", path: ["trace_id"] } },
    { label: "chain_from_s2_after_fork", bank: WS, tool: "oracle_trace_chain", args: { traceId: { $ref: "S2" } } },
    { label: "chain_from_r_after_fork", bank: WS, tool: "oracle_trace_chain", args: { traceId: { $ref: "R" } } },

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

    // 10 (fix round 2). v3's `project` and `depth` filters (v3 src/trace/
    //    list.ts:17-19) were dropped silently: `{project:"github.com/nobody/
    //    none", depth:5}` came back with the depth-0, project-less traces.
    { label: "list_project", bank: WS, tool: "oracle_trace_list", args: { project: "github.com/laris-co/example-fw", limit: 50 } },
    { label: "list_project_depth_miss", bank: WS, tool: "oracle_trace_list", args: { project: "github.com/nobody/none", depth: 5, limit: 5 } },
    { label: "list_depth_1", bank: WS, tool: "oracle_trace_list", args: { depth: 1, limit: 50 } },
    { label: "list_depth_0", bank: WS, tool: "oracle_trace_list", args: { depth: 0, limit: 50 } },
    { label: "list_depth_negative", bank: WS, tool: "oracle_trace_list", args: { depth: -1 } },
    { label: "list_depth_fraction", bank: WS, tool: "oracle_trace_list", args: { depth: 1.5 } },
    { label: "list_project_not_string", bank: WS, tool: "oracle_trace_list", args: { project: 42 } },
    { label: "list_unknown_arg", bank: WS, tool: "oracle_trace_list", args: { limit: 5, sortBy: "oldest" } },

    // 11 (fix round 2). V7's next_trace_id: S1 has exactly one successor
    //    (S2); R has two (S1 and F), a fork.
    { label: "get_s1_next", bank: WS, tool: "oracle_trace_get", args: { traceId: { $ref: "S1" } } },
    { label: "get_r_next_fork", bank: WS, tool: "oracle_trace_get", args: { traceId: { $ref: "R" } } },

    // 12 (fix round 2). A well-formed id that names no trace is an ordinary
    //    "not found" (`no_results`), not a wrapped kernel envelope.
    { label: "get_missing", bank: WS, tool: "oracle_trace_get", args: { traceId: pad("nosuchtraceforget") } },
    { label: "distill_missing", bank: WS, tool: "oracle_trace_distill", args: { traceId: pad("nosuchtracedistill"), awakening: "x" } },
    // 13 (fix round 2). A three-way fork names all three branches, not 2.
    { label: "chain_d_fork", bank: WS, tool: "oracle_trace", args: { query: "chain third branch", prevTraceId: { $ref: "A" } }, capture: { name: "D", path: ["trace_id"] } },
    { label: "chain_from_a_three_way", bank: WS, tool: "oracle_trace_chain", args: { traceId: { $ref: "A" } } },
    { label: "distill_v3_args", bank: WS, tool: "oracle_trace_distill", args: { traceId: { $ref: "T1B" }, awakening: "v3 extras ride along.", oracle: "thor", source: "stormforge", finding: { a: 1 }, metadata: { b: 2 } } },
  ]);
}, testTimeout(300_000));

type Head = { revision: { term_snapshot_json: string; link_snapshot_json: string } } | null;
async function headOf(nodeId: string): Promise<{ type: string | undefined; links: { relation: string; target_kind: string; target: unknown }[] }> {
  const reader = await openEvidenceReader(fixture.datasetRoot);
  const head = (await reader.publication.getAcceptedHead(
    new TextEncoder().encode(JSON.stringify({ workspace_name: WS, node_id: nodeId })),
  )) as Head;
  expect(head).not.toBeNull();
  const terms = JSON.parse(head!.revision.term_snapshot_json) as { vocabulary_name_snapshot: string; term_name_snapshot: string }[];
  return {
    type: terms.find((t) => t.vocabulary_name_snapshot === "type")?.term_name_snapshot,
    links: JSON.parse(head!.revision.link_snapshot_json),
  };
}

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

  test("a three-way fork names every branch (fix round 2; it used to read 2)", () => {
    expect(out.chain_from_a_three_way.isError).toBe(false);
    expect(out.chain_from_a_three_way.value.forked).toBe(true);
    expect(out.chain_from_a_three_way.value.branches.sort()).toEqual(
      [out.chain_b.value.trace_id, out.chain_c_fork.value.trace_id, out.chain_d_fork.value.trace_id].sort(),
    );
    expect(out.chain_from_a_three_way.value.compat_warnings).toBeUndefined();
  });

  test("a fork upstream of the requested trace never drops it from its own chain (fix round)", () => {
    // Before the fork exists: R <- S1 <- S2, asking about S2 sees all three.
    expect(out.chain_from_s2_before_fork.isError).toBe(false);
    expect(out.chain_from_s2_before_fork.value.chain.map((c: any) => c.trace_id)).toEqual([
      out.chain_r.value.trace_id, out.chain_s1.value.trace_id, out.chain_s2.value.trace_id,
    ]);
    expect(out.chain_from_s2_before_fork.value.position).toBe(2);
    expect(out.chain_from_s2_before_fork.value.chain_length).toBe(3);
    expect(out.chain_from_s2_before_fork.value.forked).toBeUndefined();

    // F forks off R, UPSTREAM of S1/S2 -- not at S2 itself. S2's own chain
    // (reached via S2's unambiguous prev_id pointers back through S1 to R)
    // must be unaffected: still all three, S2 still in it, at its own
    // position, never coerced to `position: 0` on a truncated `chain:[R]`.
    expect(out.chain_from_s2_after_fork.isError).toBe(false);
    expect(out.chain_from_s2_after_fork.value.chain.map((c: any) => c.trace_id)).toEqual([
      out.chain_r.value.trace_id, out.chain_s1.value.trace_id, out.chain_s2.value.trace_id,
    ]);
    expect(out.chain_from_s2_after_fork.value.position).toBe(2);
    expect(out.chain_from_s2_after_fork.value.chain_length).toBe(3);

    // Asking about R itself still sees the fork it actually sits at (R has
    // two children, S1 and F): the ambiguity is real information about R's
    // OWN forward continuation, unlike the false one the bug reported for S2.
    expect(out.chain_from_r_after_fork.isError).toBe(false);
    expect(out.chain_from_r_after_fork.value.forked).toBe(true);
    expect(out.chain_from_r_after_fork.value.branches.sort()).toEqual(
      [out.chain_s1.value.trace_id, out.chain_f_fork.value.trace_id].sort(),
    );
    expect(out.chain_from_r_after_fork.value.chain.map((c: any) => c.trace_id)).toEqual([out.chain_r.value.trace_id]);
    expect(out.chain_from_r_after_fork.value.position).toBe(0);
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

  test("R18 D4 pinned (fix round 2): promoted is type learning, unpromoted is type conclusion, both derived_from the trace", async () => {
    // The two tests above only saw `success`/`learningId`; swapping the
    // mapping in oracle_trace_distill.ts left them green. Read the published
    // heads back and check the type term and the link themselves.
    const t1 = out.t1.value.trace_id as string;
    const promotedIds = [out.distill_promoted.value.learningId, out.distill_again.value.learningId] as string[];
    // The unpromoted distill returns no id (v3's shape); it is the one
    // distillation of T1 that is not one of the two promoted ids.
    const all = out.get_t1_after_distill.value.distilled_to_ids as string[];
    const conclusionIds = all.filter((id) => !promotedIds.includes(id));
    expect(conclusionIds).toHaveLength(1);

    for (const id of promotedIds) {
      const head = await headOf(id);
      expect(head.type).toBe("learning");
      expect(head.links).toHaveLength(1);
      expect(head.links[0]).toMatchObject({ relation: "derived_from", target_kind: "trace", target: { trace_id: t1 } });
    }
    const conclusion = await headOf(conclusionIds[0]!);
    expect(conclusion.type).toBe("conclusion");
    expect(conclusion.links[0]).toMatchObject({ relation: "derived_from", target_kind: "trace", target: { trace_id: t1 } });
  });

  test("an unknown well-formed traceId is no_results, and v3-only extras are named argument_ignored (fix round 2)", () => {
    expect(out.distill_missing.isError).toBe(true);
    expect(out.distill_missing.value.compat.code).toBe("no_results");
    expect(out.distill_missing.value.error).toBe(`Trace ${pad("nosuchtracedistill")} not found`);
    expect(out.distill_v3_args.isError).toBe(false);
    const ignored = (out.distill_v3_args.value.compat_warnings ?? [])
      .filter((w: any) => w.code === "argument_ignored")
      .map((w: any) => w.field)
      .sort();
    expect(ignored).toEqual(["finding", "metadata", "oracle", "source"]);
  });

  test("the distilled node's project term is the TRACE's own project, never args.project (fix round)", async () => {
    // T1 was traced with `project: "github.com/laris-co/example-fw"`. Neither
    // v3's real call shape nor this tool's `inputSchema` has a `project`
    // argument on `oracle_trace_distill` itself -- reading one off `args`
    // (the pre-fix-round behavior) always produced `_universal`, even here.
    const reader = await openEvidenceReader(fixture.datasetRoot);
    const head = (await reader.publication.getAcceptedHead(
      new TextEncoder().encode(JSON.stringify({ workspace_name: WS, node_id: out.distill_promoted.value.learningId })),
    )) as { revision: { term_snapshot_json: string } } | null;
    expect(head).not.toBeNull();
    const terms = JSON.parse(head!.revision.term_snapshot_json) as { vocabulary_name_snapshot: string; term_name_snapshot: string }[];
    const project = terms.find((t) => t.vocabulary_name_snapshot === "project");
    expect(project?.term_name_snapshot).toBe("laris-co/example-fw");
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

  test("project filters to traces recorded under exactly that project, as v3's eq(trace_log.project) did (fix round 2)", () => {
    expect(out.list_project.isError).toBe(false);
    expect(out.list_project.value.traces.map((t: any) => t.trace_id)).toEqual([out.t1.value.trace_id]);
    expect(out.list_project.value.has_more).toBe(false);
  });

  test("the verifier's exact call: an unmatched project + depth is an empty page, never the unfiltered list (fix round 2)", () => {
    expect(out.list_project_depth_miss.isError).toBe(false);
    expect(out.list_project_depth_miss.value.traces).toEqual([]);
    expect(out.list_project_depth_miss.value.has_more).toBe(false);
    const codes = out.list_project_depth_miss.value.compat_warnings.map((w: any) => w.code);
    expect(codes).not.toContain("argument_ignored");
  });

  test("depth filters on the trace's own depth (fix round 2)", () => {
    expect(out.list_depth_1.isError).toBe(false);
    expect(out.list_depth_1.value.traces.map((t: any) => t.trace_id)).toEqual([out.t1b.value.trace_id]);
    const depth0 = out.list_depth_0.value.traces.map((t: any) => t.trace_id);
    expect(depth0).toContain(out.t1.value.trace_id);
    expect(depth0).not.toContain(out.t1b.value.trace_id);
    for (const t of out.list_depth_0.value.traces) expect(t.depth).toBe(0);
  });

  test("a depth or project v4 cannot express is refused as unsupported_argument, never dropped (fix round 2)", () => {
    for (const label of ["list_depth_negative", "list_depth_fraction"]) {
      expect(out[label].isError).toBe(true);
      expect(out[label].value.compat.code).toBe("unsupported_argument");
      expect(out[label].value.compat.path).toBe("/depth");
    }
    expect(out.list_project_not_string.isError).toBe(true);
    expect(out.list_project_not_string.value.compat.code).toBe("unsupported_argument");
    expect(out.list_project_not_string.value.compat.path).toBe("/project");
  });

  test("an argument v3 never had is named argument_ignored, never silently dropped (fix round 2)", () => {
    expect(out.list_unknown_arg.isError).toBe(false);
    expect(out.list_unknown_arg.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "argument_ignored", field: "sortBy" }));
  });

  test("scope is v3's own value: the recorded scope, else v3's default 'project' (fix round 2)", () => {
    const t1Row = out.list_all.value.traces.find((t: any) => t.trace_id === out.t1.value.trace_id);
    expect(t1Row.scope).toBe("project");
  });
});

describe("oracle_trace_get children (V7, K5)", () => {
  test("child_trace_ids includes the parentTraceId child", () => {
    expect(out.get_t1_children.value.child_trace_ids).toContain(out.t1b.value.trace_id);
  });

  test("next_trace_id names the single successor, and is null with semantic_change on a fork (fix round 2)", () => {
    expect(out.get_s1_next.isError).toBe(false);
    expect(out.get_s1_next.value.next_trace_id).toBe(out.chain_s2.value.trace_id);
    expect(out.get_s1_next.value.prev_trace_id).toBe(out.chain_r.value.trace_id);
    expect(out.get_r_next_fork.isError).toBe(false);
    expect(out.get_r_next_fork.value.next_trace_id).toBeNull();
    expect(out.get_r_next_fork.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "semantic_change", field: "next_trace_id" }));
  });

  test("an unknown well-formed traceId is no_results with v3's text (fix round 2)", () => {
    expect(out.get_missing.isError).toBe(true);
    expect(out.get_missing.value.compat.code).toBe("no_results");
    expect(out.get_missing.value.error).toBe(`Trace ${pad("nosuchtraceforget")} not found`);
  });
});

describe("catalogue (fix round 2)", () => {
  test("oracle_trace_list advertises v3's project and depth, and says what changed", () => {
    const spec = V3_CATALOGUE.find((t) => t.name === "oracle_trace_list")!;
    const props = (spec.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["depth", "limit", "offset", "project", "query", "status"]);
    expect(spec.description).toContain("case-sensitive");
    expect(spec.description).toContain("raw or distilled");
  });

  test("oracle_trace_chain no longer claims forward walking is missing", () => {
    const spec = V3_CATALOGUE.find((t) => t.name === "oracle_trace_chain")!;
    expect(spec.description).not.toContain("needs trace listing");
  });
});
