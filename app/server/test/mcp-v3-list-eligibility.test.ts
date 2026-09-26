// R18 D3 fix round (v3-list slice): the v3 RECALL tools -- oracle_reflect,
// oracle_recap, oracle_inbox, and inbox's `total` -- must return ONLY nodes
// the system's own eligibility check calls eligible (V3-PARITY.md A6,
// DECISIONS.md R18 D3, #29's full rule: not retired/superseded, head
// `is_active`, inside `[valid_from, valid_to)` at request time). The BROWSE
// tool, oracle_list, keeps them, flagged.
//
// Written failing-first: the independent verifier's scratch repro showed all
// three recall tools returning heads with `is_active:false` and closed
// validity windows, because they listed through `listNodes`'s default view,
// which drops only terminal (retired/superseded) nodes.
//
// Real gate, real dataset, real wire, same gated child as mcp-v3-list.test.ts.
// Each ineligible node is made the realistic way: a v3 write tool publishes
// it eligible, then a successor revision (the generic kb_ facade -- no v3
// tool edits `is_active` or a window) forgets it or closes its window. That
// is exactly the shape the copy migration leaves for a forgotten legacy
// memory (`migration/buildRevisionRequest.ts` copies `is_active`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";
import { runGated } from "./helpers/publication-fixture";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "writes-child.ts");
const MIXED = "ws-elig-mixed";
const ALLBAD = "ws-elig-allbad";
/** Two eligible learnings among five: P(16 unfiltered draws all landing on
 *  an eligible one) is about (2/5)^16, i.e. under 1e-6. Post-fix every draw
 *  is eligible by construction, so this can only flake on a real regression. */
const REFLECT_REPEATS = 16;

let taxonomy: TaxonomyFixture;
let work: string;
let home: string;
let out: Record<string, any> = {};

const learn = (label: string, bank: string) => ({
  label, bank, tool: "oracle_learn", args: { pattern: `pattern for ${label}`, concepts: ["eligibility"] }, capture: { name: label, path: ["id"] },
});
const handoff = (label: string, bank: string) => ({
  label, bank, tool: "oracle_handoff", args: { content: `# Handoff ${label}\nbody`, slug: label }, capture: { name: label, path: ["id"] },
});
/** Publish a successor revision of `label` with `change` applied, keeping its
 *  term snapshot (so a learning stays a learning, a handoff stays tagged
 *  `concepts:handoff`). */
const successor = (label: string, bank: string, change: Record<string, unknown>) => {
  const head = (suffix: string, path: string[]) => ({
    label: `${label}_${suffix}`, bank, tool: "kb_getAcceptedHead",
    args: { payload: { workspace_name: bank, node_id: { $ref: label } } }, capture: { name: `${label}_${suffix}`, path },
  });
  return [
    head("rev", ["revision", "id"]),
    head("terms", ["revision", "term_snapshot_json"]),
    {
      label: `${label}_next`, bank, tool: "kb_publishRevision",
      args: { payload: { operation_id: `op-elig-${label}`, content: {
        workspace_name: bank, node_id: { $ref: label }, base_revision_id: { $ref: `${label}_rev` },
        title: `title ${label}`, body: `body ${label}`, body_format: "markdown", fields: "{}",
        author_peer_name: null, observer_peer_name: null, subject_peer_name: null, session_name: null,
        is_active: true, valid_from: null, valid_to: null, change_reason: "eligibility fixture",
        schema_version: "1", canonical_version: "arra-revision/v1",
        term_snapshot_json: { $ref: `${label}_terms` }, link_snapshot_json: "[]", h_metadata: null, internal_metadata: null,
        ...change,
      } } },
    },
  ];
};
const eligibility = (label: string, bank: string) => ({
  label: `elig_${label}`, bank, tool: "kb_getRecallEligibility", args: { payload: { workspace_name: bank, node_id: { $ref: label } } },
});

const FORGET = { is_active: false };
const EXPIRE = { valid_from: "2019-01-01T00:00:00.000Z", valid_to: "2020-01-01T00:00:00.000Z" };
const NOT_YET = { valid_from: "2099-01-01T00:00:00.000Z" };
const INELIGIBLE = { l_forgot: ["inactive"], l_expired: ["expired"], l_future: ["not_yet_valid"], h_forgot: ["inactive"], h_expired: ["expired"] } as const;
const id = (label: string) => out[label].value.id as string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arra-v3-list-elig-"));
  home = await mkdtemp(join(tmpdir(), "arra-v3-list-elig-home-"));
  await mkdir(join(work, "legacy"));
  taxonomy = await createTaxonomyFixture([MIXED, ALLBAD]);

  const steps = [
    learn("l_ok", MIXED),
    learn("l_forgot", MIXED), ...successor("l_forgot", MIXED, FORGET),
    learn("l_expired", MIXED), ...successor("l_expired", MIXED, EXPIRE),
    learn("l_future", MIXED), ...successor("l_future", MIXED, NOT_YET),
    // Eligible, but its title tries to inject a markdown heading into recap.
    learn("l_title", MIXED), ...successor("l_title", MIXED, { title: "first line\n## injected heading" }),
    handoff("h_ok", MIXED),
    handoff("h_forgot", MIXED), ...successor("h_forgot", MIXED, FORGET),
    handoff("h_expired", MIXED), ...successor("h_expired", MIXED, { valid_to: "2020-01-01T00:00:00.000Z" }),
    ...Object.keys(INELIGIBLE).map((label) => eligibility(label, MIXED)),

    { label: "recap", bank: MIXED, tool: "oracle_recap", args: { limit: 30 } },
    { label: "recap_cwd", bank: MIXED, tool: "oracle_recap", args: { limit: 30, cwd: "/tmp/wherever" } },
    { label: "inbox", bank: MIXED, tool: "oracle_inbox", args: {} },
    { label: "inbox_limit1", bank: MIXED, tool: "oracle_inbox", args: { limit: 1 } },
    { label: "inbox_offset1", bank: MIXED, tool: "oracle_inbox", args: { offset: 1 } },
    ...Array.from({ length: REFLECT_REPEATS }, (_, i) => ({ label: `reflect_${i}`, bank: MIXED, tool: "oracle_reflect", args: {} })),
    { label: "list_all", bank: MIXED, tool: "oracle_list", args: { limit: 30 } },
    { label: "list_learning", bank: MIXED, tool: "oracle_list", args: { type: "learning", limit: 30 } },
    { label: "list_default", bank: MIXED, tool: "oracle_list", args: {} },
    { label: "list_type_num", bank: MIXED, tool: "oracle_list", args: { type: 5 } },
    { label: "list_type_blank", bank: MIXED, tool: "oracle_list", args: { type: "   " } },
    {
      label: "kb_eligible", bank: MIXED, tool: "kb_listNodes",
      args: { payload: { workspace_name: MIXED, after_id: null, limit: 100, include_total: true, type_term: null, eligible_only: true } },
    },
    {
      label: "kb_contradiction", bank: MIXED, tool: "kb_listNodes",
      args: { payload: { workspace_name: MIXED, after_id: null, limit: 10, include_total: false, type_term: null, eligible_only: true, include_inactive: true } },
    },

    learn("b_forgot", ALLBAD), ...successor("b_forgot", ALLBAD, FORGET),
    handoff("b_hexp", ALLBAD), ...successor("b_hexp", ALLBAD, EXPIRE),
    { label: "reflect_allbad", bank: ALLBAD, tool: "oracle_reflect", args: {} },
    { label: "inbox_allbad", bank: ALLBAD, tool: "oracle_inbox", args: {} },
    { label: "recap_allbad", bank: ALLBAD, tool: "oracle_recap", args: {} },
    { label: "list_allbad", bank: ALLBAD, tool: "oracle_list", args: {} },
  ];

  const result = await runGated(taxonomy.datasetRoot, CHILD, [taxonomy.datasetRoot, work, JSON.stringify({ banks: [MIXED, ALLBAD], operator: [], steps })], {
    deadlineMs: scaledMs(240_000),
    env: { ARRA_DATA_DIR: join(work, "legacy"), ARRA_KNOWLEDGE_DATASET_ROOT: taxonomy.datasetRoot, HOME: home },
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (result.code !== 0 || line === undefined) throw new Error(`writes-child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  out = JSON.parse(line);
}, testTimeout(300_000));

afterAll(async () => {
  await taxonomy?.cleanup();
  for (const dir of [work, home]) if (dir) await rm(dir, { recursive: true, force: true });
});

describe("fixture: the kernel's own eligibility check calls each forgotten/closed node ineligible", () => {
  test("every successor landed, and getRecallEligibility names the expected reason", () => {
    for (const label of ["l_forgot", "l_expired", "l_future", "l_title", "h_forgot", "h_expired", "b_forgot", "b_hexp"]) {
      expect({ label, isError: out[`${label}_next`].isError, outcome: out[`${label}_next`].value?.outcome }).toEqual({ label, isError: false, outcome: "accepted" });
    }
    for (const [label, reasons] of Object.entries(INELIGIBLE)) {
      expect({ label, ...out[`elig_${label}`].value }).toMatchObject({ label, eligible: false, reasons });
    }
  });
});

describe("recall tools return only recall-eligible nodes (R18 D3)", () => {
  test("oracle_recap lists the eligible entries and none of the forgotten, expired or not-yet-valid ones", () => {
    const recap = out.recap.value as string;
    expect(out.recap.isError).toBe(false);
    for (const label of ["l_ok", "l_title", "h_ok"]) expect(recap).toContain(id(label));
    for (const label of Object.keys(INELIGIBLE)) expect({ label, present: recap.includes(id(label)) }).toEqual({ label, present: false });
  });

  test("oracle_inbox shows only the eligible handoff, and total counts that SAME filtered set", () => {
    expect(out.inbox.isError).toBe(false);
    expect(out.inbox.value.files.map((f: any) => f.filename)).toEqual(["h_ok"]);
    expect(out.inbox.value.total).toBe(1);
    expect(out.inbox_limit1.value.total).toBe(1);
    expect(out.inbox_offset1.value).toMatchObject({ files: [], total: 1, offset: 1 });
  });

  test("oracle_reflect never draws an ineligible learning", () => {
    const eligible = [id("l_ok"), id("l_title")];
    for (let i = 0; i < REFLECT_REPEATS; i += 1) {
      const step = out[`reflect_${i}`];
      expect(step.isError).toBe(false);
      expect({ draw: i, eligible: eligible.includes(step.value.principle.id) }).toEqual({ draw: i, eligible: true });
    }
  });

  test("a bank whose every node is ineligible: reflect answers no_results, inbox is empty with total 0, recap has no entries", () => {
    expect(out.reflect_allbad.isError).toBe(true);
    expect(out.reflect_allbad.value.compat.code).toBe("no_results");
    expect(out.inbox_allbad.value).toMatchObject({ files: [], total: 0 });
    const recap = out.recap_allbad.value as string;
    expect(recap).not.toContain(id("b_forgot"));
    expect(recap).not.toContain(id("b_hexp"));
    expect(recap).not.toContain("- **");
  });

  test("kb_listNodes exposes the same recall view on the generic wire: eligible_only, total null, and no mixing with history mode", () => {
    expect(out.kb_eligible.isError).toBe(false);
    const listed = out.kb_eligible.value.rows.map((row: any) => row.id).sort();
    expect(listed).toEqual([id("l_ok"), id("l_title"), id("h_ok")].sort());
    expect(out.kb_eligible.value.total).toBeNull();
    expect(out.kb_contradiction.isError).toBe(true);
    expect(JSON.stringify(out.kb_contradiction.value)).toContain("/eligible_only");
  });
});

describe("oracle_list is browse: ineligible nodes stay, flagged with the kernel's own reasons", () => {
  test("every node is listed; each ineligible one carries ineligible_reasons, an eligible one carries none", () => {
    expect(out.list_all.isError).toBe(false);
    const docs = new Map<string, any>(out.list_all.value.documents.map((d: any) => [d.id, d]));
    expect(out.list_all.value.total).toBe(8);
    for (const [label, reasons] of Object.entries(INELIGIBLE)) {
      expect({ label, reasons: docs.get(id(label))?.ineligible_reasons }).toEqual({ label, reasons: [...reasons] });
    }
    for (const label of ["l_ok", "l_title", "h_ok"]) {
      expect(docs.has(id(label))).toBe(true);
      expect({ label, reasons: docs.get(id(label)).ineligible_reasons }).toEqual({ label, reasons: undefined });
    }
  });

  test("a type filter keeps the same flags (learnings only)", () => {
    const docs = new Map<string, any>(out.list_learning.value.documents.map((d: any) => [d.id, d]));
    expect(docs.size).toBe(5);
    expect(docs.get(id("l_forgot")).ineligible_reasons).toEqual(["inactive"]);
    expect(docs.get(id("l_expired")).ineligible_reasons).toEqual(["expired"]);
    expect(docs.get(id("l_future")).ineligible_reasons).toEqual(["not_yet_valid"]);
  });

  test("a bank of only ineligible nodes still browses both, flagged", () => {
    const docs = out.list_allbad.value.documents;
    expect(docs.map((d: any) => d.id).sort()).toEqual([id("b_forgot"), id("b_hexp")].sort());
    for (const doc of docs) expect(Array.isArray(doc.ineligible_reasons)).toBe(true);
  });
});

describe("cheap nonblocking fixes from the same review", () => {
  test("oracle_list refuses a non-string or blank type (v3 refused both) instead of silently listing everything", () => {
    for (const label of ["list_type_num", "list_type_blank"]) {
      expect({ label, isError: out[label].isError }).toEqual({ label, isError: true });
      expect(out[label].value.compat).toMatchObject({ code: "unsupported_argument", path: "/type" });
    }
  });

  test("oracle_list and oracle_inbox default to v3's own limit of 10", () => {
    expect(out.list_default.value.limit).toBe(10);
    expect(out.inbox.value.limit).toBe(10);
  });

  test("oracle_recap: a title cannot inject a markdown heading (whitespace collapses, as v3's compact() did)", () => {
    const recap = out.recap.value as string;
    expect(recap).not.toMatch(/^## injected heading/m);
    expect(recap).toContain("first line ## injected heading");
  });

  test("oracle_recap with a dispatch-level warning (cwd) still has exactly ONE compat footer", () => {
    const recap = out.recap_cwd.value as string;
    expect(recap.split("\n---\n").length).toBe(2);
    expect(recap).toContain("_compat(argument_ignored): cwd");
    expect(recap).toContain("_compat(field_unavailable): heat");
  });
});
