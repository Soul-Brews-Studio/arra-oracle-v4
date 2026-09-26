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

const HEAD = (label: string, bank: string, ofLabel: string) => ({
  label,
  bank,
  tool: "kb_getAcceptedHead",
  args: { payload: { workspace_name: bank, node_id: { $ref: ofLabel } } },
});
const RECONCILE = (label: string, bank: string, nodeRef: string, revisionRef: string) => ({
  label,
  bank,
  tool: "kb_reconcileRevisionAssociations",
  args: { payload: { workspace_name: bank, node_id: { $ref: nodeRef }, revision_id: { $ref: revisionRef } } },
});

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
    { label: "learn1", bank: BANK_A, tool: "oracle_learn", args: { pattern: "APFS snapshots: tmutil localsnapshot before disk surgery", concepts: ["apfs", "backup"] }, capture: { name: "learn1", path: ["id"] } },
    { ...HEAD("learn1_head", BANK_A, "learn1"), capture: { name: "learn1_rev", path: ["revision", "id"] } },
    RECONCILE("reconcile1", BANK_A, "learn1", "learn1_rev"),
    { label: "learn2", bank: BANK_A, tool: "oracle_learn", args: { pattern: "APFS snapshots also work over Time Machine", concepts: ["apfs"] }, capture: { name: "learn2", path: ["id"] } },
    { ...HEAD("learn2_head", BANK_A, "learn2"), capture: { name: "learn2_rev", path: ["revision", "id"] } },
    RECONCILE("reconcile2", BANK_A, "learn2", "learn2_rev"),
    { label: "concepts", bank: BANK_A, tool: "oracle_concepts", args: {} },
    { label: "concepts_filtered", bank: BANK_A, tool: "oracle_concepts", args: { type: "learning", limit: 1 } },
    { label: "stats", bank: BANK_A, tool: "oracle_stats", args: {} },
    // A workspace with real content but no reconciled associations: an
    // honest "no concepts vocabulary yet" (K2 lookup miss), not an error.
    { label: "learn_b", bank: BANK_B, tool: "oracle_learn", args: { pattern: "unrelated content in another bank" }, capture: { name: "learn_b", path: ["id"] } },
    { label: "concepts_b", bank: BANK_B, tool: "oracle_concepts", args: {} },
    { label: "stats_b", bank: BANK_B, tool: "oracle_stats", args: {} },
  ]);
}, 300_000);

afterAll(async () => {
  await taxonomy?.cleanup();
  if (work) await rm(work, { recursive: true, force: true });
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
    expect(value.total_documents).toBeGreaterThanOrEqual(2);
    expect(value.by_type.learning).toBeGreaterThanOrEqual(2);
    expect(value.fts_indexed).toBeGreaterThanOrEqual(2);
    expect(value.unique_concepts).toBe(2);
    // Nothing has been embedded yet: chunks exist (pending) but none are ready.
    expect(value.vector_status).toBe("pending");
    expect(typeof value.last_indexed).toBe("string");
    expect(typeof value.version).toBe("string");
    expect(value.fts_status).toBe("healthy");
  });

  test("matches the v3 shape fixture", () => {
    const shape = loadShape("oracle_stats");
    const errors = matchesShape(out.stats.value, shape[PRIMARY_KEY.oracle_stats!] as Record<string, unknown>, shape);
    expect(errors).toEqual([]);
  });

  test("a fresh bank with one unreconciled entry: total_documents counts it, unique_concepts is 0", () => {
    const value = out.stats_b.value;
    expect(value.total_documents).toBeGreaterThanOrEqual(1);
    expect(value.unique_concepts).toBe(0);
  });

  test("isolation: bank B's counts never include bank A's nodes", () => {
    expect(out.stats_b.value.total_documents).toBeLessThan(out.stats.value.total_documents);
  });
});
