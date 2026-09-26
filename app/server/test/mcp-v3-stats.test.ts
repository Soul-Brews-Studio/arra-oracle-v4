// Slice V8 -- `oracle_concepts` and `oracle_stats` (docs/overnight/
// V3-PARITY.md §3 A1, §4.3/§4.4, §7 "V8"; DECISIONS.md R18 (K6+K7+V8)).
// Written BEFORE the two tools existed: `availability()` answered
// "not implemented in this build" for both, so `tools/list` never listed
// them and every `tools/call` step below would have failed the
// `expectListed`/200 assertions with `GAP`/403, never `PASS`.
//
// Real gate, real dataset, real wire: `fixtures/v3-compat-v1/core/writes-child.ts`
// (a generic MCP-call replayer, not specific to any one v3 tool) boots the
// production app inside `exec_with_gate` on a genuinely fresh, taxonomy-empty
// workspace, so `oracle_learn`'s K2 bootstrap is exercised for real before
// `oracle_concepts`/`oracle_stats` read the result back.
//
// FIRST FIX ROUND: this file used to call `kb_reconcileRevisionAssociations`
// by hand after each `oracle_learn`, a call no real v3 client can make, which
// hid that nothing on the v3 write path filled the `node_revision_terms`
// projection K6 then read.
//
// SECOND FIX ROUND (the verifier's blocking finding): the first fix made the
// v3 write path reconcile, but left the reader counting the DERIVED
// projection, so every OTHER writer -- `kb_publishRevision`, HTTP, the v4 UI
// -- was still silently undercounted with `coverage:"full"`. The verifier's
// repro is reproduced below verbatim: a `kb_publishRevision` of a second node
// carrying learn1's exact `term_snapshot_json`, which nothing ever
// reconciles. Seen RED before the fix: `oracle_concepts` answered
// `apfs:2, backup:1` (the published terms give 3 and 2), with no warning.
// `listTermUsage` now counts the accepted heads' own snapshots, so no step
// here reconciles anything, and none needs to.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";
import { runGated } from "./helpers/publication-fixture";
import { loadShape, matchesShape, PRIMARY_KEY } from "./helpers/v3-compat-shapes";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "writes-child.ts");
const BANK_A = "ws-stats-a";
const BANK_B = "ws-stats-b";

let taxonomy: TaxonomyFixture;
let work: string;
let out: Record<string, any> = {};

/** A `publishRevision` content object, field for field what `mcp/legacy-v3/publish.ts` sends. */
function rawContent(workspace: string, nodeId: string, termSnapshot: unknown) {
  return {
    workspace_name: workspace,
    node_id: nodeId,
    base_revision_id: null,
    title: "published through kb_publishRevision, never reconciled",
    body: "APFS snapshot notes, written by a plain v4 client",
    body_format: "markdown",
    fields: "{}",
    author_peer_name: null,
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: null,
    is_active: true,
    valid_from: null,
    valid_to: null,
    change_reason: null,
    schema_version: "1",
    canonical_version: "arra-revision/v1",
    term_snapshot_json: termSnapshot,
    link_snapshot_json: "[]",
    h_metadata: null,
    internal_metadata: null,
  };
}

async function runChild(root: string, banks: string[], steps: unknown[]) {
  const result = await runGated(root, CHILD, [root, work, JSON.stringify({ banks, operator: [], steps })], {
    deadlineMs: scaledMs(180_000),
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
    // No `kb_reconcileRevisionAssociations` step anywhere here: nothing in
    // this session ever fills the `node_revision_terms` projection.
    { label: "learn1", bank: BANK_A, tool: "oracle_learn", args: { pattern: "APFS snapshots: tmutil localsnapshot before disk surgery", concepts: ["apfs", "backup"] }, capture: { name: "learn1", path: ["id"] } },
    { label: "learn2", bank: BANK_A, tool: "oracle_learn", args: { pattern: "APFS snapshots also work over Time Machine", concepts: ["apfs"] }, capture: { name: "learn2", path: ["id"] } },
    // The verifier's repro: a plain v4 write (no v3 adapter, no reconcile)
    // of a third node carrying learn1's exact snapshot (apfs + backup).
    { label: "head1", bank: BANK_A, tool: "kb_getAcceptedHead", args: { payload: { workspace_name: BANK_A, node_id: { $ref: "learn1" } } }, capture: { name: "snap1", path: ["revision", "term_snapshot_json"] } },
    { label: "raw_publish", as: "free", bank: BANK_A, tool: "kb_publishRevision", args: { payload: { operation_id: "v3-stats-raw-publish-1", content: rawContent(BANK_A, "rawpublishnode0000001", { $ref: "snap1" }) } } },
    { label: "concepts", bank: BANK_A, tool: "oracle_concepts", args: {} },
    { label: "concepts_filtered", bank: BANK_A, tool: "oracle_concepts", args: { type: "learning", limit: 1 } },
    { label: "concepts_principle", bank: BANK_A, tool: "oracle_concepts", args: { type: "principle" } },
    { label: "stats", bank: BANK_A, tool: "oracle_stats", args: {} },
    // A workspace with real content but nothing ever tagged with a concept:
    // an honest "no concepts vocabulary yet" (K2 lookup miss), not an error.
    { label: "learn_b", bank: BANK_B, tool: "oracle_learn", args: { pattern: "unrelated content in another bank" }, capture: { name: "learn_b", path: ["id"] } },
    { label: "concepts_b", bank: BANK_B, tool: "oracle_concepts", args: {} },
    { label: "stats_b", bank: BANK_B, tool: "oracle_stats", args: {} },
  ]);
}, testTimeout(300_000));

afterAll(async () => {
  await taxonomy?.cleanup();
  if (work) await rm(work, { recursive: true, force: true });
});

describe("the verifier's repro: a node no one reconciled is still counted", () => {
  test("kb_publishRevision of learn1's snapshot is accepted (a real, published, never-reconciled head)", () => {
    expect(out.head1.isError).toBe(false);
    expect(typeof out.head1.value.revision.term_snapshot_json).toBe("string");
    expect(out.raw_publish.isError).toBe(false);
    expect(out.raw_publish.value.outcome).toBe("accepted");
  });
});

describe("oracle_concepts (V8, K6)", () => {
  test("counts concept usage over EVERY current head's published terms, ranked by count then name", () => {
    const res = out.concepts;
    expect(res.isError).toBe(false);
    // learn1 (apfs, backup) + learn2 (apfs) + raw_publish (apfs, backup).
    expect(res.value).toEqual({
      concepts: [
        { name: "apfs", count: 3 },
        { name: "backup", count: 2 },
      ],
      total_unique: 2,
      filter_type: "all",
    });
  });

  test("type learning is v3's own type, kept as-is: filtered, and no warning", () => {
    const res = out.concepts_filtered;
    expect(res.isError).toBe(false);
    expect(res.value).toEqual({ concepts: [{ name: "apfs", count: 3 }], total_unique: 2, filter_type: "learning" });
  });

  test("type principle has no v4 type of that name: an empty answer named by a semantic_change warning", () => {
    const res = out.concepts_principle;
    expect(res.isError).toBe(false);
    expect(res.value.concepts).toEqual([]);
    expect(res.value.filter_type).toBe("principle");
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
    // BANK_A has exactly learn1 + learn2 + raw_publish, all type learning.
    // Only the two oracle_learn nodes were indexed (a raw kb_publishRevision
    // indexes nothing), each a single sub-1000-char chunk. Exact, not >=, so
    // a doubled or dropped count fails this instead of surviving a loose bound.
    expect(value.total_documents).toBe(3);
    expect(value.by_type).toEqual({ learning: 3 });
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
