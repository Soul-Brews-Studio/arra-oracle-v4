// K5 (docs/overnight/V3-PARITY.md §5; overnight R18 fix round 2):
// `derived_from_count` counts only links whose revision is still its node's
// CURRENT head. A verifier mutation that counted every `derived_from` row
// regardless of head left every existing test green; this pins the rule.
//
// Real publisher, real reconcile, one gated run: node A is published
// `derived_from` the seeded trace, then revised WITHOUT the link; node B is
// published `derived_from` it and left alone. `revision_links` then holds
// two `derived_from` rows for the trace (A's first revision keeps its
// reconciled row -- rows are per revision), but only B's is a current head.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openEvidenceReader } from "../src/publication/service";
import { assocId, reconcileRequest } from "./helpers/association-fixture";
import { createFixture, revisionEnvelope, runGated, type Fixture, type SeededWorkspace } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/association-v1/core/gated-association.ts", import.meta.url).pathname;
const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
const ALPHA = "alpha-workspace";
const NODE_A = assocId("headsNodeA");
const NODE_B = assocId("headsNodeB");
const REV_A1 = assocId("headsRevA1");
const REV_A2 = assocId("headsRevA2");
const REV_B1 = assocId("headsRevB1");

let fixture: Fixture;
let seeded: SeededWorkspace;
let run: Record<string, any>;

const derivedFrom = (traceId: string) =>
  JSON.stringify([
    {
      position: "0", relation: "derived_from", target_kind: "trace", target: { trace_id: traceId },
      excerpt: null, content_hash: null, captured_at: null, capture_status: "locator_only", note: null,
    },
  ]);

beforeAll(async () => {
  fixture = await createFixture([ALPHA]);
  seeded = fixture.workspaces[ALPHA]!;
  const pub = (request: unknown) => ({ facade: "publication", method: "publishRevision", request });
  const reconcile = (node_id: string, revision_id: string) => ({
    facade: "evidence", method: "reconcileRevisionAssociations", request: reconcileRequest(ALPHA, { node_id, revision_id }),
  });
  const ops = [
    pub({ operation_id: "op-heads-a1", content: revisionEnvelope(ALPHA, seeded, NODE_A, { link_snapshot_json: derivedFrom(seeded.trace_id) }) }),
    reconcile(NODE_A, REV_A1),
    pub({ operation_id: "op-heads-b1", content: revisionEnvelope(ALPHA, seeded, NODE_B, { link_snapshot_json: derivedFrom(seeded.trace_id) }) }),
    reconcile(NODE_B, REV_B1),
    pub({ operation_id: "op-heads-a2", content: revisionEnvelope(ALPHA, seeded, NODE_A, { base_revision_id: REV_A1, body: "revised, no longer derived", link_snapshot_json: "[]" }) }),
    reconcile(NODE_A, REV_A2),
    {
      facade: "harness", method: "readRawRows",
      request: { table: "revision_links", predicate: `workspace_name = '${ALPHA}' AND relation = 'derived_from'` },
    },
  ];
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops, clockMs: CLOCK, revisionIds: [REV_A1, REV_B1, REV_A2] }),
  ]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 1500)}`);
  run = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}");
  for (let i = 0; i < 6; i++) {
    if (run[`op${i}`]?.ok !== true) throw new Error(`op${i} failed: ${JSON.stringify(run[`op${i}`])}`);
  }
}, testTimeout(180_000));

afterAll(async () => {
  await fixture?.cleanup();
});

describe("K5 kernel: derived_from_count counts current heads only", () => {
  test("premise: both derived_from rows are physically present in revision_links", () => {
    const rows = run.op6.value as { revision_id: string }[];
    expect(rows.map((r) => r.revision_id).sort()).toEqual([REV_A1, REV_B1].sort());
  });

  test("the superseded revision's link does not count; the current head's does", async () => {
    const reader = await openEvidenceReader(fixture.datasetRoot);
    const listed = (await (reader.context as unknown as { listTraces(b: Uint8Array): Promise<{ rows: { id: string; derived_from_count: number }[] }> })
      .listTraces(new TextEncoder().encode(JSON.stringify({
        workspace_name: ALPHA, parent_id: null, prev_id: null, depth: null, query_contains: null,
        after_created_at: null, after_id: null, limit: 10,
      }))));
    const row = listed.rows.find((r) => r.id === seeded.trace_id);
    expect(row).toBeDefined();
    expect(row!.derived_from_count).toBe(1);
  });
});
