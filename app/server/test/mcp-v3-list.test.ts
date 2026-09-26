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
import { derivedId } from "../src/mcp/legacy-v3/ids.derivedId";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "writes-child.ts");
const FRESH = "ws-v6-fresh";
const EMPTY = "ws-v6-empty";
/** A valid nanoid21-shaped id for the hand-built "principle" node below. */
const PRINCIPLE_NODE_ID = `${"k3reflectprinciple"}${"0".repeat(21)}`.slice(0, 21);
/** Enough repeated draws that BOTH the `learning` and `principle` pools show
 *  up at least once with overwhelming probability (each is a 50/50 coin
 *  flip when both pools are nonempty; P(either pool missing across 12 draws)
 *  = 2 x 2^-12, about 0.049% -- corrected in the R18 D3 fix round, this
 *  previously claimed < 0.03%). */
const REFLECT_REPEATS = 12;

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
    deadlineMs: scaledMs(180_000),
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

    // K3 upgrade to oracle_reflect (fix round): a "note"+`legacy_type:
    // principle` node, built directly through the generic kb_ facade --
    // no existing v3 write tool produces this shape yet (oracle_learn/
    // oracle_research_note both hardcode type:"learning", D4). Ids are
    // DERIVED the same deterministic way taxonomy.ensureVocabulary.ts/
    // ensureTerm.ts create them, so this is exactly the row a real
    // principle-writing tool would leave behind. `author_peer_name`/
    // `session_name` null, the same as every other node this file's own
    // v3 tools (oracle_learn et al.) already write with no X-Arra-Peer set.
    {
      label: "principle_vocab", bank: FRESH, tool: "kb_createVocabulary",
      args: { payload: {
        workspace_name: FRESH, vocabulary_id: derivedId(FRESH, "vocabulary", "legacy_type"),
        name: "legacy_type", label: "legacy_type", description: null, kind: "tags",
        term_policy: "open", cardinality: "many", required: false, hierarchy: "flat",
      } },
    },
    {
      label: "principle_term", bank: FRESH, tool: "kb_createTerm",
      args: { payload: {
        workspace_name: FRESH, term_id: derivedId(FRESH, "term", "legacy_type", "principle"),
        vocabulary_id: derivedId(FRESH, "vocabulary", "legacy_type"),
        name: "principle", description: null, parent_id: null,
      } },
    },
    {
      label: "p1", bank: FRESH, tool: "kb_publishRevision",
      args: { payload: { operation_id: "op-k3-reflect-principle", content: {
        workspace_name: FRESH, node_id: PRINCIPLE_NODE_ID, base_revision_id: null,
        title: "measure twice", body: "measure twice, cut once", body_format: "markdown", fields: "{}",
        author_peer_name: null, observer_peer_name: null, subject_peer_name: null,
        session_name: null, is_active: true, valid_from: null, valid_to: null,
        change_reason: null, schema_version: "1", canonical_version: "arra-revision/v1",
        term_snapshot_json: JSON.stringify([
          { term_id: derivedId(FRESH, "term", "type", "note"), vocabulary_id: derivedId(FRESH, "vocabulary", "type"),
            vocabulary_name_snapshot: "type", term_name_snapshot: "note", label_snapshot: null, position: "0" },
          { term_id: derivedId(FRESH, "term", "legacy_type", "principle"), vocabulary_id: derivedId(FRESH, "vocabulary", "legacy_type"),
            vocabulary_name_snapshot: "legacy_type", term_name_snapshot: "principle", label_snapshot: null, position: "1" },
        ]),
        link_snapshot_json: "[]", h_metadata: null, internal_metadata: null,
      } } },
      capture: { name: "p1", path: ["node_id"] },
    },

    // oracle_list
    { label: "list_learning", bank: FRESH, tool: "oracle_list", args: { type: "learning", limit: 30 } },
    { label: "list_all", bank: FRESH, tool: "oracle_list", args: { limit: 30 } },
    { label: "list_type_all", bank: FRESH, tool: "oracle_list", args: { type: "all", limit: 30 } },
    { label: "list_no_such_legacy_type", bank: FRESH, tool: "oracle_list", args: { type: "no-such-legacy-type" } },
    { label: "list_asOf", bank: FRESH, tool: "oracle_list", args: { asOf: "2026-06-17T00:00:00Z" } },
    // A REAL legacy_type filter (test strength: the only prior legacy_type
    // coverage was the not-found case above) -- p1 is the one node tagged
    // legacy_type:principle.
    { label: "list_principle", bank: FRESH, tool: "oracle_list", args: { type: "principle" } },

    // oracle_reflect: one plain draw, plus enough repeats that both the
    // `learning` and the new `principle` pool (K3) are proven reachable
    // (`REFLECT_REPEATS`'s doc comment explains the bound).
    { label: "reflect", bank: FRESH, tool: "oracle_reflect", args: {} },
    ...Array.from({ length: REFLECT_REPEATS }, (_, i) => ({ label: `reflect_r${i}`, bank: FRESH, tool: "oracle_reflect", args: {} })),

    // oracle_inbox
    { label: "inbox_default", bank: FRESH, tool: "oracle_inbox", args: {} },
    { label: "inbox_limit1", bank: FRESH, tool: "oracle_inbox", args: { limit: 1 } },
    { label: "inbox_all", bank: FRESH, tool: "oracle_inbox", args: { type: "all" } },
    { label: "inbox_bad_type", bank: FRESH, tool: "oracle_inbox", args: { type: "bogus" } },

    // oracle_recap
    { label: "recap", bank: FRESH, tool: "oracle_recap", args: { limit: 30 } },
    { label: "recap_maxTokens", bank: FRESH, tool: "oracle_recap", args: { limit: 30, maxTokens: 200 } },
    // A2's `cwd`-ignored warning, on a STRING-returning tool: dispatchLegacyV3's
    // generic warnings merge must not silently drop it just because recap's
    // result is a markdown string rather than a JSON object.
    { label: "recap_cwd", bank: FRESH, tool: "oracle_recap", args: { limit: 5, cwd: "/tmp/wherever" } },
  ]);

  outEmpty = await runChild(taxonomy.datasetRoot, [FRESH, EMPTY], [
    { label: "reflect_empty", bank: EMPTY, tool: "oracle_reflect", args: {} },
    { label: "inbox_empty", bank: EMPTY, tool: "oracle_inbox", args: {} },
    { label: "list_empty", bank: EMPTY, tool: "oracle_list", args: {} },
    { label: "recap_empty", bank: EMPTY, tool: "oracle_recap", args: {} },
  ]);
}, testTimeout(300_000));

afterAll(async () => {
  await taxonomy?.cleanup();
  for (const dir of [work, home]) if (dir) await rm(dir, { recursive: true, force: true });
});

describe("oracle_list (V6)", () => {
  test("type: learning includes both learnings, INCLUDES the retired one flagged (browse mode: include_inactive under the hood)", () => {
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

  test("no type filter includes the handoffs and the principle too, and total is exact (no term filter is active)", () => {
    const res = out.list_all.value;
    const ids = res.documents.map((d: any) => d.id);
    expect(ids).toEqual(expect.arrayContaining([out.l1.value.id, out.l2.value.id, out.rn1.value.id, out.h1.value.id, out.h2.value.id, out.p1.value.node_id]));
    expect(res.total).toBe(6);
    expect(res.type).toBe("all");
    expect(res.compat_warnings).toContainEqual(expect.objectContaining({ code: "field_unavailable", field: "source_file" }));
  });

  // Test strength (fix round): this file previously never asserted
  // oracle_list's own newest-first (K4) order -- p1 was published after
  // every other node in this bank's step sequence, so it must sort first.
  test("K4: browse mode is newest-updated first", () => {
    const ids = out.list_all.value.documents.map((d: any) => d.id);
    expect(ids[0]).toBe(out.p1.value.node_id);
  });

  // Test strength (fix round): the only prior legacy_type coverage was the
  // NOT-FOUND case; this exercises a real match through the K3 `any_term_ids`
  // path oracle_list's `type` filter uses for anything other than "learning".
  test("a real legacy_type filter matches the tagged node, and nothing else", () => {
    const res = out.list_principle.value;
    expect(out.list_principle.isError).toBe(false);
    const ids = res.documents.map((d: any) => d.id);
    expect(ids).toEqual([out.p1.value.node_id]);
    expect(res.type).toBe("principle");
  });

  // Fix round (Opus verifier): v3's `type` enum is `['principle','pattern',
  // 'learning','retro','all']`, `default:'all'` (arra-oracle-v3@61e5f8b6
  // src/tools/list.ts) -- 'all' means "no filter", the SAME as omitting the
  // key, never a legacy_type NAME to look up (there is no vocabulary term
  // literally named "all"). Before the fix this silently returned an empty
  // page: v3's own documented default value produced silent data loss.
  test("type: 'all' is v3's documented default value for 'no filter', not a legacy_type name -- same result as omitting type", () => {
    const res = out.list_type_all.value;
    expect(out.list_type_all.isError).toBe(false);
    const ids = res.documents.map((d: any) => d.id);
    expect(ids).toEqual(expect.arrayContaining([out.l1.value.id, out.l2.value.id, out.rn1.value.id, out.h1.value.id, out.h2.value.id, out.p1.value.node_id]));
    expect(res.total).toBe(6);
    expect(res.type).toBe("all");
  });

  test("a type with no matching legacy_type vocabulary is an honest empty page, not an error", () => {
    const res = out.list_no_such_legacy_type.value;
    expect(out.list_no_such_legacy_type.isError).toBe(false);
    expect(res).toMatchObject({ documents: [], total: 0, type: "no-such-legacy-type" });
  });

  // Fix round: V3-PARITY.md §4.3 -- "asOf returns unsupported_argument,
  // because there is no historical browse." Before the fix this argument
  // was never read at all: a caller asking for a historical view silently
  // got the present one instead.
  test("asOf is refused with unsupported_argument, never silently ignored", () => {
    expect(out.list_asOf.isError).toBe(true);
    expect(out.list_asOf.value.compat.code).toBe("unsupported_argument");
    expect(out.list_asOf.value.compat.path).toBe("/asOf");
  });

  test("an empty workspace returns an empty page", () => {
    expect(outEmpty.list_empty.isError).toBe(false);
    expect(outEmpty.list_empty.value.documents).toEqual([]);
  });
});

describe("oracle_reflect (V6)", () => {
  const eligibleIds = () => [out.l2.value.id, out.rn1.value.id, out.p1.value.node_id];

  test("returns an eligible learning or principle, never the retired one (the recall path is eligible-only)", () => {
    expect(out.reflect.isError).toBe(false);
    const principle = out.reflect.value.principle;
    expect(eligibleIds()).toContain(principle.id);
    expect(principle.id).not.toBe(out.l1.value.id);
    expect(["learning", "principle"]).toContain(principle.type);
    expect(typeof principle.content).toBe("string");
  });

  // K3 fix round: V3-PARITY §7 lists V6 as "upgrades oracle_list,
  // oracle_reflect", and v3 sampled BOTH `principle` and `learning`. Before
  // the fix, reflect sampled `type_term:"learning"` only -- draw the tool
  // enough times that BOTH pools are proven reachable, not just declared so
  // in a comment.
  test("samples BOTH the learning pool and the K3 legacy_type:principle pool across repeated draws, never the retired node", () => {
    const types = new Set<string>();
    const ids = new Set<string>();
    for (let i = 0; i < REFLECT_REPEATS; i++) {
      const step = out[`reflect_r${i}`];
      expect(step.isError).toBe(false);
      const principle = step.value.principle;
      expect(eligibleIds()).toContain(principle.id);
      types.add(principle.type);
      ids.add(principle.id);
    }
    expect(types.has("learning")).toBe(true);
    expect(types.has("principle")).toBe(true);
    expect(ids.has(out.p1.value.node_id)).toBe(true);
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
  // Fix round (Opus verifier): V3-PARITY.md §2.5 says "oracle_recap returns a
  // markdown string, as v3 did; text() passes strings through", and v3's own
  // recap.ts:52 returns raw markdown text. Before the fix this tool returned
  // a JSON object `{recap, entries, compat_warnings}` -- the probe's
  // `typeof value` was "object", not "string".
  test("the whole tool result IS the markdown string (not a JSON object wrapping one) -- eligible entries only, never the retired one", () => {
    expect(out.recap.isError).toBe(false);
    const res = out.recap.value;
    expect(typeof res).toBe("string");
    expect(res).toContain(`Recap: ${FRESH}`);
    expect(res).toContain(out.h2.value.id);
    expect(res).toContain(out.h1.value.id);
    expect(res).toContain(out.l2.value.id);
    expect(res).toContain(out.rn1.value.id);
    expect(res).toContain(out.p1.value.node_id);
    // l1 is retired: excluded from the recall path exactly like reflect.
    expect(res).not.toContain(out.l1.value.id);
    expect(res).toContain("heat ranking is not carried");
  });

  // Fix round: v3's recap.ts also takes `maxTokens` (200-1200); v4 has no
  // token count and fits a fixed character budget in the adapter instead.
  // Before the fix, `maxTokens` was read nowhere: `{maxTokens:200}` produced
  // output identical to `{}`, with no warning that the argument did nothing.
  test("maxTokens is accepted for v3 compatibility, ignored, and NAMED as ignored -- not silently dropped", () => {
    expect(out.recap_maxTokens.isError).toBe(false);
    const res = out.recap_maxTokens.value;
    expect(typeof res).toBe("string");
    expect(res).toContain(`Recap: ${FRESH}`);
    expect(res).toContain("argument_ignored");
    expect(res).toContain("maxTokens");
  });

  // Fix round: dispatchLegacyV3's A2 `cwd`-ignored warning must reach a
  // STRING-returning tool too -- the generic warnings merge only handled an
  // object result, so this warning would otherwise vanish silently the
  // moment recap stopped returning one.
  test("dispatchLegacyV3's cwd-ignored warning reaches a string result too", () => {
    expect(out.recap_cwd.isError).toBe(false);
    const res = out.recap_cwd.value;
    expect(typeof res).toBe("string");
    expect(res).toContain("argument_ignored");
    expect(res).toContain("cwd");
  });

  test("an empty workspace still answers with the identity line and zero entries", () => {
    expect(outEmpty.recap_empty.isError).toBe(false);
    const res = outEmpty.recap_empty.value;
    expect(typeof res).toBe("string");
    expect(res).toContain(`Recap: ${EMPTY}`);
    expect(res).not.toContain("##");
    expect(res).not.toContain("- **");
  });
});
