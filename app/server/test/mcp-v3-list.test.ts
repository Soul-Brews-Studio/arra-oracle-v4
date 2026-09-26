// Slice V6 -- the v3 knowledge browse/recall reads: oracle_list, oracle_reflect,
// oracle_inbox, oracle_recap (docs/overnight/V3-PARITY.md §4.3/§4.4/§5, §7 "V6";
// DECISIONS.md R18). Written BEFORE the four tools existed, reusing the SAME
// gated child V1 already proved out (`fixtures/v3-compat-v1/core/writes-child.ts`
// is a generic {label,bank,tool,args,capture} step runner -- no child changes
// needed for read-only tools).
//
// Real gate, real dataset, real wire: the child boots the production app
// inside `exec_with_gate` and replays MCP calls; what is asserted is what a
// client would read. `kb_retireNode` is called directly (V2's oracle_supersede
// is a different slice) to put ONE node into history, so oracle_list's
// browse-with-lifecycle-flag path has something real to flag.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";
import { runGated } from "./helpers/publication-fixture";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "writes-child.ts");
const FRESH = "ws-v6-fresh";
const EMPTY = "ws-v6-empty";

const HEAD = (label: string, bank = FRESH) => ({
  label, bank, tool: "kb_getAcceptedHead",
  args: { payload: { workspace_name: bank, node_id: { $ref: label.replace(/^head_/, "") } } },
});

let taxonomy: TaxonomyFixture;
let work: string;
let home: string;
let out: Record<string, any> = {};
let outEmpty: Record<string, any> = {};

async function runChild(root: string, banks: string[], steps: unknown[]) {
  const result = await runGated(root, CHILD, [root, work, JSON.stringify({ banks, operator: [], steps })], {
    deadlineMs: 180_000,
    env: { ARRA_DATA_DIR: join(work, "legacy"), ARRA_KNOWLEDGE_DATASET_ROOT: root, HOME: home },
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (result.code !== 0 || line === undefined) throw new Error(`writes-child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  return JSON.parse(line);
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arra-v3-list-"));
  home = await mkdtemp(join(tmpdir(), "arra-v3-list-home-"));
  await mkdir(join(work, "legacy"));
  taxonomy = await createTaxonomyFixture([FRESH, EMPTY]);

  out = await runChild(taxonomy.datasetRoot, [FRESH, EMPTY], [
    { label: "l1", bank: FRESH, tool: "oracle_learn", args: { pattern: "APFS snapshots: tmutil localsnapshot before disk surgery", concepts: ["apfs"], project: "github.com/laris-co/homelab" }, capture: { name: "l1", path: ["id"] } },
    HEAD("head_l1"),
    { label: "l2", bank: FRESH, tool: "oracle_learn", args: { pattern: "หลงลืม: forgetting is binary is_active", concepts: ["thai"] }, capture: { name: "l2", path: ["id"] } },
    { label: "rn1", bank: FRESH, tool: "oracle_research_note", args: { title: "Chunk search needs an inside-word Thai tokenizer", question: "Why does icu miss ลืม?" }, capture: { name: "rn1", path: ["id"] } },
    { label: "h1", bank: FRESH, tool: "oracle_handoff", args: { content: "# Handoff: fleet cleanup\n\n## Done\n- pruned", slug: "fleet-cleanup" }, capture: { name: "h1", path: ["id"] } },
    { label: "h2", bank: FRESH, tool: "oracle_handoff", args: { content: "# Handoff: second, newer\nbody", slug: "second-newer" }, capture: { name: "h2", path: ["id"] } },
    // Put l1 into history directly through the generic kb_ tool -- V2's
    // oracle_supersede is a different slice; retireNode is already exposed.
    { label: "l1_head_probe", bank: FRESH, tool: "kb_getAcceptedHead", args: { payload: { workspace_name: FRESH, node_id: { $ref: "l1" } } }, capture: { name: "l1_rev", path: ["revision", "id"] } },
    {
      label: "l1_retire", bank: FRESH, tool: "kb_retireNode",
      args: { payload: { workspace_name: FRESH, node_id: { $ref: "l1" }, expected_revision_id: { $ref: "l1_rev" }, reason: "v6 test: put one node into history", peer_name: null, operation_id: "op-v6-retire-l1" } },
    },

    // oracle_list
    { label: "list_learning", bank: FRESH, tool: "oracle_list", args: { type: "learning", limit: 30 } },
    { label: "list_all", bank: FRESH, tool: "oracle_list", args: { limit: 30 } },
    { label: "list_no_such_legacy_type", bank: FRESH, tool: "oracle_list", args: { type: "no-such-legacy-type" } },

    // oracle_reflect
    { label: "reflect", bank: FRESH, tool: "oracle_reflect", args: {} },

    // oracle_inbox
    { label: "inbox_default", bank: FRESH, tool: "oracle_inbox", args: {} },
    { label: "inbox_limit1", bank: FRESH, tool: "oracle_inbox", args: { limit: 1 } },
    { label: "inbox_all", bank: FRESH, tool: "oracle_inbox", args: { type: "all" } },
    { label: "inbox_bad_type", bank: FRESH, tool: "oracle_inbox", args: { type: "bogus" } },

    // oracle_recap
    { label: "recap", bank: FRESH, tool: "oracle_recap", args: { limit: 30 } },
  ]);

  outEmpty = await runChild(taxonomy.datasetRoot, [FRESH, EMPTY], [
    { label: "reflect_empty", bank: EMPTY, tool: "oracle_reflect", args: {} },
    { label: "inbox_empty", bank: EMPTY, tool: "oracle_inbox", args: {} },
    { label: "list_empty", bank: EMPTY, tool: "oracle_list", args: {} },
    { label: "recap_empty", bank: EMPTY, tool: "oracle_recap", args: {} },
  ]);
}, 300_000);

afterAll(async () => {
  await taxonomy?.cleanup();
  for (const dir of [work, home]) if (dir) await rm(dir, { recursive: true, force: true });
});

describe("oracle_list (V6)", () => {
  test("type: learning includes both learnings, EXCLUDES the retired one by default view, but browses it with include_inactive under the hood so a later toggle would find it", () => {
    const res = out.list_learning.value;
    expect(out.list_learning.isError).toBe(false);
    const ids = res.documents.map((d: any) => d.id);
    expect(ids).toContain(out.l2.value.id);
    expect(ids).toContain(out.rn1.value.id);
    // l1 was retired -- still a "learning" by type, and oracle_list is BROWSE
    // mode (include_inactive: true), so it is present, flagged.
    expect(ids).toContain(out.l1.value.id);
    const l1Doc = res.documents.find((d: any) => d.id === out.l1.value.id);
    expect(l1Doc.superseded_by).toBeNull();
    expect(l1Doc.superseded_reason).toBe("v6 test: put one node into history");
    expect(typeof l1Doc.superseded_at).toBe("string");
    const l2Doc = res.documents.find((d: any) => d.id === out.l2.value.id);
    expect(l2Doc.superseded_by).toBeUndefined();
    expect(res.type).toBe("learning");
  });

  test("no type filter includes the handoffs too, and total is exact (no term filter is active)", () => {
    const res = out.list_all.value;
    const ids = res.documents.map((d: any) => d.id);
    expect(ids).toEqual(expect.arrayContaining([out.l1.value.id, out.l2.value.id, out.rn1.value.id, out.h1.value.id, out.h2.value.id]));
    expect(res.total).toBe(5);
    expect(res.type).toBe("all");
    expect(res.compat_warnings).toContainEqual(expect.objectContaining({ code: "field_unavailable", field: "source_file" }));
  });

  test("a type with no matching legacy_type vocabulary is an honest empty page, not an error", () => {
    const res = out.list_no_such_legacy_type.value;
    expect(out.list_no_such_legacy_type.isError).toBe(false);
    expect(res).toMatchObject({ documents: [], total: 0, type: "no-such-legacy-type" });
  });

  test("an empty workspace returns an empty page", () => {
    expect(outEmpty.list_empty.isError).toBe(false);
    expect(outEmpty.list_empty.value.documents).toEqual([]);
  });
});

describe("oracle_reflect (V6)", () => {
  test("returns a learning, never the retired one (the recall path is eligible-only)", () => {
    expect(out.reflect.isError).toBe(false);
    const principle = out.reflect.value.principle;
    expect([out.l2.value.id, out.rn1.value.id]).toContain(principle.id);
    expect(principle.id).not.toBe(out.l1.value.id);
    expect(principle.type).toBe("learning");
    expect(typeof principle.content).toBe("string");
  });

  test("an empty workspace answers no_results, not a thrown error (v3 threw)", () => {
    expect(outEmpty.reflect_empty.isError).toBe(true);
    expect(outEmpty.reflect_empty.value.compat.code).toBe("no_results");
  });
});

describe("oracle_inbox (V6)", () => {
  test("newest handoff first, filename is the slug title, total counts both", () => {
    const res = out.inbox_default.value;
    expect(out.inbox_default.isError).toBe(false);
    expect(res.files.length).toBe(2);
    expect(res.files[0].filename).toBe("second-newer");
    expect(res.files[1].filename).toBe("fleet-cleanup");
    expect(res.files[0].type).toBe("handoff");
    expect(res.files[0].path).toBeNull();
    expect(res.total).toBe(2);
  });

  test("limit:1 returns only the newest, but total still counts both", () => {
    const res = out.inbox_limit1.value;
    expect(res.files.length).toBe(1);
    expect(res.files[0].filename).toBe("second-newer");
    expect(res.total).toBe(2);
  });

  test("type: all behaves like handoff, with a semantic_change warning", () => {
    const res = out.inbox_all.value;
    expect(res.files.length).toBe(2);
    expect(res.compat_warnings).toContainEqual(expect.objectContaining({ code: "semantic_change", field: "type" }));
  });

  test("an unsupported type value is refused, not silently ignored", () => {
    expect(out.inbox_bad_type.isError).toBe(true);
    expect(out.inbox_bad_type.value.compat.code).toBe("unsupported_argument");
    expect(out.inbox_bad_type.value.compat.path).toBe("/type");
  });

  test("an empty workspace returns an empty inbox, not an error", () => {
    expect(outEmpty.inbox_empty.isError).toBe(false);
    expect(outEmpty.inbox_empty.value).toMatchObject({ files: [], total: 0 });
  });
});

describe("oracle_recap (V6)", () => {
  test("a markdown identity line, and the eligible entries -- never the retired one", () => {
    const res = out.recap.value;
    expect(out.recap.isError).toBe(false);
    expect(typeof res.recap).toBe("string");
    expect(res.recap).toContain(`Recap: ${FRESH}`);
    expect(res.recap).toContain(out.h2.value.id);
    expect(res.recap).toContain(out.h1.value.id);
    expect(res.recap).toContain(out.l2.value.id);
    expect(res.recap).toContain(out.rn1.value.id);
    // l1 is retired: excluded from the recall path exactly like reflect.
    expect(res.recap).not.toContain(out.l1.value.id);
    expect(res.entries).toBe(4);
    expect(res.compat_warnings).toContainEqual(expect.objectContaining({ code: "field_unavailable", field: "heat" }));
  });

  test("an empty workspace still answers with the identity line and zero entries", () => {
    expect(outEmpty.recap_empty.isError).toBe(false);
    expect(outEmpty.recap_empty.value.entries).toBe(0);
    expect(outEmpty.recap_empty.value.recap).toContain(`Recap: ${EMPTY}`);
  });
});
