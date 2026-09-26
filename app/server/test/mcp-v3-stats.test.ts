// Slice V8 -- `oracle_concepts` and `oracle_stats` (docs/overnight/
// V3-PARITY.md §3 A1, §4.3/§4.4, §7 "V8"; DECISIONS.md R18 (K6+K7+V8)).
// Written BEFORE the two tools existed: `availability()` answered
// "not implemented in this build" for both, so `tools/list` never listed
// them and every `tools/call` step below would have failed the
// `expectListed`/200 assertions with `GAP`/403, never `PASS`.
//
// Real gate, real dataset, real wire: `fixtures/v3-compat-v1/core/writes-child.ts`
// (unmodified -- it is a generic MCP-call replayer, not specific to any one
// v3 tool) boots the production app inside `exec_with_gate` on a genuinely
// fresh, taxonomy-empty workspace, so `oracle_learn`'s K2 bootstrap and K6's
// `reconcileRevisionAssociations` are both exercised for real before
// `oracle_concepts`/`oracle_stats` read the result back.
//
// FIX ROUND (an independent verifier's finding on the first cut of this
// slice): this file used to call `kb_reconcileRevisionAssociations` by hand
// after each `oracle_learn` step, through the raw `kb_*` registry name --
// a call no real v3 client can make, since it is `content:write` and no
// `V3_CATALOGUE` entry ever exposes it. That hid the actual production bug:
// `publish.ts` (the ONE place every v3 write goes through) never reconciled
// associations itself, so a real `oracle_learn` left `node_revision_terms`
// empty forever and `oracle_concepts`/`oracle_stats.unique_concepts` silently
// answered zero, with no warning. Deleting those hand-inserted steps (which
// is what the verifier did in a scratch copy to prove it) is the RED for
// this fix: with `reconcileRevisionAssociations` still absent from
// `publish.ts`'s call sequence, `concepts`/`stats` below fail exactly as the
// verifier reported. The fix moved the reconcile call into `publish()`
// itself (`mcp/legacy-v3/publish.ts`), so no step below calls it by hand
// anymore -- these steps are now a plain, unmodified v3 client session.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";
import { runGated } from "./helpers/publication-fixture";
import { loadShape, matchesShape, PRIMARY_KEY } from "./helpers/v3-compat-shapes";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "writes-child.ts");
const BANK_A = "ws-stats-a";
const BANK_B = "ws-stats-b";

let taxonomy: TaxonomyFixture;
let work: string;
let out: Record<string, any> = {};

async function runChild(root: string, banks: string[], steps: unknown[]) {
  const result = await runGated(root, CHILD, [root, work, JSON.stringify({ banks, operator: [], steps })], {
    deadlineMs: 180_000,
    env: { ARRA_DATA_DIR: join(work, "legacy"), ARRA_KNOWLEDGE_DATASET_ROOT: root },
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (result.code !== 0 || line === undefined) throw new Error(`writes-child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  return JSON.parse(line);
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arra-v3-stats-"));
  await mkdir(join(work, "legacy"));
  taxonomy = await createTaxonomyFixture([BANK_A, BANK_B]);

  out = await runChild(taxonomy.datasetRoot, [BANK_A, BANK_B], [
    // No `kb_reconcileRevisionAssociations` step anywhere here: a real v3
    // client only ever calls the `oracle_*` names below. Reconciliation now
    // happens inside `publish()` itself, once per `oracle_learn`.
    { label: "learn1", bank: BANK_A, tool: "oracle_learn", args: { pattern: "APFS snapshots: tmutil localsnapshot before disk surgery", concepts: ["apfs", "backup"] }, capture: { name: "learn1", path: ["id"] } },
    { label: "learn2", bank: BANK_A, tool: "oracle_learn", args: { pattern: "APFS snapshots also work over Time Machine", concepts: ["apfs"] }, capture: { name: "learn2", path: ["id"] } },
    { label: "concepts", bank: BANK_A, tool: "oracle_concepts", args: {} },
    { label: "concepts_filtered", bank: BANK_A, tool: "oracle_concepts", args: { type: "learning", limit: 1 } },
    { label: "stats", bank: BANK_A, tool: "oracle_stats", args: {} },
    // A workspace with real content but nothing ever tagged with a concept:
    // an honest "no concepts vocabulary yet" (K2 lookup miss), not an error.
    { label: "learn_b", bank: BANK_B, tool: "oracle_learn", args: { pattern: "unrelated content in another bank" }, capture: { name: "learn_b", path: ["id"] } },
    { label: "concepts_b", bank: BANK_B, tool: "oracle_concepts", args: {} },
    { label: "stats_b", bank: BANK_B, tool: "oracle_stats", args: {} },
  ]);
}, 300_000);

afterAll(async () => {
  await taxonomy?.cleanup();
  if (work) await rm(work, { recursive: true, force: true });
});

describe("oracle_learn (V1) auto-reconciles associations (fix round, verifier finding 1)", () => {
  test("plain oracle_learn calls -- no kb_reconcileRevisionAssociations step -- report no associations gap", () => {
    for (const label of ["learn1", "learn2"] as const) {
      const res = out[label];
      expect(res.isError).toBe(false);
      expect(res.value.success).toBe(true);
      const warnings = (res.value.compat_warnings ?? []) as { field: string }[];
      expect(warnings).not.toContainEqual(expect.objectContaining({ field: "concepts" }));
    }
  });
});

describe("oracle_concepts (V8, K6)", () => {
  test("counts concept usage over reconciled current heads, ranked by count then name", () => {
    const res = out.concepts;
    expect(res.isError).toBe(false);
    expect(res.value).toMatchObject({
      concepts: [
        { name: "apfs", count: 2 },
        { name: "backup", count: 1 },
      ],
      total_unique: 2,
      filter_type: "all",
    });
  });

  test("type filters on v4's own type vocabulary, with a semantic_change warning", () => {
    const res = out.concepts_filtered;
    expect(res.isError).toBe(false);
    expect(res.value.concepts).toEqual([{ name: "apfs", count: 2 }]);
    expect(res.value.filter_type).toBe("learning");
    expect(res.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "semantic_change", field: "type" }));
  });

  test("matches the v3 shape fixture", () => {
    const shape = loadShape("oracle_concepts");
    const errors = matchesShape(out.concepts.value, shape.topLevel as Record<string, unknown>, shape);
    expect(errors).toEqual([]);
  });

  test("a bank with content but no concepts vocabulary yet answers an exact empty list, not an error", () => {
    const res = out.concepts_b;
    expect(res.isError).toBe(false);
    expect(res.value).toEqual({ concepts: [], total_unique: 0, filter_type: "all" });
  });

  test("isolation: bank B never sees bank A's concept counts", () => {
    expect(out.concepts_b.value.concepts).not.toContainEqual(expect.objectContaining({ name: "apfs" }));
  });
});

describe("oracle_stats (V8, K7 full shape)", () => {
  test("total_documents, by_type, unique_concepts and vector_status are measured, not guessed", () => {
    const res = out.stats;
    expect(res.isError).toBe(false);
    const value = res.value;
    // BANK_A has exactly learn1 + learn2, both type learning, each a
    // single sub-1000-char chunk: exact, not >=, so a doubled or dropped
    // count fails this instead of surviving under a loose bound.
    expect(value.total_documents).toBe(2);
    expect(value.by_type).toEqual({ learning: 2 });
    expect(value.fts_indexed).toBe(2);
    expect(value.unique_concepts).toBe(2);
    // Nothing has been embedded yet: chunks exist (pending) but none are ready.
    expect(value.vector_status).toBe("pending");
    expect(typeof value.last_indexed).toBe("string");
    expect(typeof value.version).toBe("string");
    expect(value.fts_status).toBe("healthy");
    expect(value.compat_warnings).toBeUndefined();
  });

  test("matches the v3 shape fixture", () => {
    const shape = loadShape("oracle_stats");
    const errors = matchesShape(out.stats.value, shape[PRIMARY_KEY.oracle_stats!] as Record<string, unknown>, shape);
    expect(errors).toEqual([]);
  });

  test("a fresh bank with one entry that was never tagged: total_documents counts it, unique_concepts is 0", () => {
    const value = out.stats_b.value;
    expect(value.total_documents).toBe(1);
    expect(value.unique_concepts).toBe(0);
  });

  test("isolation: bank B's counts never include bank A's nodes", () => {
    expect(out.stats_b.value.total_documents).toBeLessThan(out.stats.value.total_documents);
  });
});
