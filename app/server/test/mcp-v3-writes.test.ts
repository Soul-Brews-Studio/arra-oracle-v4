// Slice V1 -- the v3 knowledge writes: oracle_learn, oracle_research_note,
// oracle_handoff (docs/overnight/V3-PARITY.md §3 A4/A5/A7/A8, §4.3, §7 "V1";
// DECISIONS.md R18 D2/D4). Written BEFORE the three tools existed.
//
// Real gate, real dataset, real wire: `fixtures/v3-compat-v1/core/writes-child.ts`
// boots the production app inside `exec_with_gate` and replays MCP calls; the
// only seam is an injected indexRevisionChunks failure for one step. Reads
// back through `kb_*` on the same app, so what is asserted is what a client
// would read.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, runGated, type Fixture } from "./helpers/publication-fixture";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";
import { activeEmbeddingProfileId } from "../src/publication/search-chunk";
import { testTimeout } from "./helpers/timing.testTimeout";
import { scaledMs } from "./helpers/timing.scaledMs";

const CHILD = join(import.meta.dir, "fixtures", "v3-compat-v1", "core", "writes-child.ts");
const FRESH = "ws-fresh";
const SEALED = "ws-sealed";
const REQUIRED = "ws-required";
const SEEDED = "ws-seeded";
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const PATTERN = "APFS snapshots: tmutil localsnapshot before disk surgery\nIt is instant and local.";
const HEAD = (label: string, bank = FRESH) => ({ label, bank, tool: "kb_getAcceptedHead", args: { payload: { workspace_name: bank, node_id: { $ref: label.replace(/^head_/, "") } } } });
const COUNT = (label: string, bank: string) => ({
  label, bank, tool: "kb_listNodes",
  args: { payload: { workspace_name: bank, after_id: null, limit: 1, include_total: true, type_term: null } },
});

let taxonomy: TaxonomyFixture;
let seeded: Fixture;
let work: string;
let home: string;
let cwd: string;
let out: Record<string, any> = {};
let outSeeded: Record<string, any> = {};

async function runChild(root: string, banks: string[], steps: unknown[], operator: unknown[] = []) {
  const result = await runGated(root, CHILD, [root, work, JSON.stringify({ banks, operator, steps, cwd })], {
    deadlineMs: scaledMs(180_000),
    // No runtime transpiler cache: it would be the only file in HOME (R13).
    env: { ARRA_DATA_DIR: join(work, "legacy"), ARRA_KNOWLEDGE_DATASET_ROOT: root, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (result.code !== 0 || line === undefined) throw new Error(`writes-child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  return JSON.parse(line);
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arra-v3-writes-"));
  home = await mkdtemp(join(tmpdir(), "arra-v3-home-"));
  cwd = await mkdtemp(join(tmpdir(), "arra-v3-cwd-"));
  await mkdir(join(work, "legacy"));
  taxonomy = await createTaxonomyFixture([FRESH, SEALED, REQUIRED]);
  seeded = await createFixture([SEEDED]);

  const vocabulary = (bank: string, id: string, name: string, termPolicy: string, required: boolean) => ({
    facade: "taxonomy", method: "createVocabulary",
    request: { workspace_name: bank, vocabulary_id: id, name, label: name, description: null, kind: "tags", term_policy: termPolicy, cardinality: "many", required, hierarchy: "flat" },
  });
  // Operator staging runs first, in its own gated child (see writes-child.ts).
  const staged = await runChild(taxonomy.datasetRoot, [FRESH, SEALED, REQUIRED], [], [
    vocabulary(SEALED, pad("sealedconcepts"), "concepts", "sealed", false),
    vocabulary(REQUIRED, pad("houserules"), "house_rules", "open", true),
  ]);
  out = await runChild(taxonomy.datasetRoot, [FRESH, SEALED, REQUIRED], [
    // A fresh workspace: no vocabulary at all yet.
    { label: "learn", bank: FRESH, tool: "oracle_learn", args: { pattern: PATTERN, concepts: [" apfs ", "backup", "apfs", ""], project: "github.com/Laris-Co/homelab", source: "va test" }, capture: { name: "learn", path: ["id"] } },
    HEAD("head_learn"),
    // The revision id is writer-assigned, so it is captured from the head.
    { label: "learn_rev_probe", bank: FRESH, tool: "kb_getAcceptedHead", args: { payload: { workspace_name: FRESH, node_id: { $ref: "learn" } } }, capture: { name: "learn_rev", path: ["revision", "id"] } },
    { label: "chunks", bank: FRESH, tool: "kb_listSearchChunks", args: { payload: { workspace_name: FRESH, revision_id: { $ref: "learn_rev" }, chunker_version: "chunker/v1", embedding_profile: activeEmbeddingProfileId() } } },
    { label: "learn_again", bank: FRESH, tool: "oracle_learn", args: { pattern: "second, no project" }, capture: { name: "learn_again", path: ["id"] } },
    HEAD("head_learn_again"),
    { label: "retry_1", bank: FRESH, tool: "oracle_learn", args: { pattern: "retried", idempotency_key: "k-1" } },
    { label: "retry_2", bank: FRESH, tool: "oracle_learn", args: { pattern: "retried", idempotency_key: "k-1" } },
    { label: "handoff", bank: FRESH, tool: "oracle_handoff", peer: "neo", args: { content: "# Handoff: fleet cleanup\n\n## Done\n- pruned", slug: "fleet-cleanup" }, capture: { name: "handoff", path: ["id"] } },
    HEAD("head_handoff"),
    { label: "handoff_anon", bank: FRESH, tool: "oracle_handoff", args: { content: "# Handoff: second\nbody" }, capture: { name: "handoff_anon", path: ["id"] } },
    HEAD("head_handoff_anon"),
    { label: "handoff_unbound", bank: FRESH, tool: "oracle_handoff", args: { content: "x", peer: "nat" } },
    { label: "note", bank: FRESH, tool: "oracle_research_note", args: {
      title: "Chunk search needs an inside-word Thai tokenizer",
      question: "Why does icu miss ลืม?",
      repo: "Soul-Brews-Studio/arra-oracle-v4",
      issue: 10,
      repoEvidence: [{ path: "app/server/src/db.ts", summary: "legacy index" }],
      externalSources: [{ url: "https://lancedb.github.io/lancedb/fts/", title: "LanceDB FTS", summary: "ngram tokenizer" }],
      recommendation: "ngram(3,3)",
      concepts: ["fts"],
    }, capture: { name: "note", path: ["id"] } },
    HEAD("head_note"),
    // v3 saved a note whatever its evidence urls held. One passes a bare
    // ^https?:// check but not the kernel's url grammar (a space).
    { label: "note_bad_url", bank: FRESH, tool: "oracle_research_note", args: {
      title: "Evidence with one malformed url",
      externalSources: [
        { url: "http://x y", title: "broken", summary: "has a space" },
        { url: "https://example.org/ok", title: "fine", summary: "a valid url" },
        { url: "https://user:pw@example.org/", summary: "credentials in the url" },
      ],
      repo: "a/..",
      issue: 3,
    }, capture: { name: "note_bad_url", path: ["id"] } },
    HEAD("head_note_bad_url"),
    { label: "count_before_fail", bank: FRESH, tool: "kb_listNodes", args: { payload: { workspace_name: FRESH, after_id: null, limit: 1, include_total: true, type_term: null } } },
    { label: "index_fails", bank: FRESH, tool: "oracle_learn", failIndex: true, args: { pattern: "published, never indexed" }, capture: { name: "index_fails_rev", path: ["v4", "revision_id"] } },
    { label: "reconcile", bank: FRESH, tool: "kb_reconcileSearchChunks", args: { payload: { workspace_name: FRESH, limit: 1024 } } },
    { label: "too_big", bank: FRESH, tool: "oracle_learn", args: { pattern: "x".repeat(300 * 1024) } },
    COUNT("count_after", FRESH),
    // A sealed adapter vocabulary: a new concept cannot be created in it.
    COUNT("sealed_count_before", SEALED),
    { label: "sealed", bank: SEALED, tool: "oracle_learn", args: { pattern: "needs a new concept", concepts: ["never-created"] } },
    COUNT("sealed_count_after", SEALED),
    // A required vocabulary the adapter cannot fill.
    { label: "required", bank: REQUIRED, tool: "oracle_learn", args: { pattern: "cannot satisfy house rules" } },
    COUNT("required_count", REQUIRED),
  ]);
  out.operator = staged.operator;

  // The publication fixture: `type` and `memory_horizon` already exist under
  // the exporter's own ids, and `type` has no `learning` term.
  outSeeded = await runChild(seeded.datasetRoot, [SEEDED], [
    { label: "learn", bank: SEEDED, tool: "oracle_learn", args: { pattern: "works on a workspace another writer seeded", concepts: ["seeded"] }, capture: { name: "learn", path: ["id"] } },
    HEAD("head_learn", SEEDED),
  ]);
}, testTimeout(300_000));

afterAll(async () => {
  await taxonomy?.cleanup();
  await seeded?.cleanup();
  for (const dir of [work, home, cwd]) if (dir) await rm(dir, { recursive: true, force: true });
});

const terms = (head: any) => JSON.parse(head.revision.term_snapshot_json) as { vocabulary_name_snapshot: string; term_name_snapshot: string }[];
const termsOf = (head: any, vocabulary: string) => terms(head).filter((t) => t.vocabulary_name_snapshot === vocabulary).map((t) => t.term_name_snapshot).sort();

describe("oracle_learn (V1 #1, #2, A8)", () => {
  test("on a fresh workspace it publishes a learning with concept and project terms, and answers v3's shape", () => {
    const res = out.learn;
    expect(res.status).toBe(200);
    expect(res.isError).toBe(false);
    expect(res.value).toMatchObject({ success: true, file: null, embedding: "enqueued" });
    expect(res.value.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(res.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "field_unavailable", field: "file" }));
    expect(typeof res.value.message).toBe("string");
    const head = out.head_learn.value;
    expect(head.node.id).toBe(res.value.id);
    expect(res.value.v4).toEqual({ node_id: head.node.id, revision_id: head.revision.id });
    expect(head.revision.body).toBe(PATTERN);
    expect(head.revision.title).toBe("APFS snapshots: tmutil localsnapshot before disk surgery");
    expect(head.revision.author_peer_name).toBeNull();
    expect(termsOf(head, "type")).toEqual(["learning"]);
    expect(termsOf(head, "concepts")).toEqual(["apfs", "backup"]);
    expect(termsOf(head, "project")).toEqual(["laris-co/homelab"]);
    expect(JSON.parse(head.revision.fields)).toEqual({ source: "va test" });
  });

  test("its chunks are indexed pending, for the backfill to embed", () => {
    expect(out.chunks.isError).toBe(false);
    const rows = Array.isArray(out.chunks.value) ? out.chunks.value : out.chunks.value.rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.status).toBe("pending");
  });

  test("no project means _universal; the title is capped at 80 characters", () => {
    expect(termsOf(out.head_learn_again.value, "project")).toEqual(["_universal"]);
    expect(out.head_learn_again.value.revision.title.length).toBeLessThanOrEqual(80);
  });

  test("an idempotency_key replays to the same node instead of writing twice", () => {
    expect(out.retry_1.value.id).toBe(out.retry_2.value.id);
    expect(out.retry_2.value.success).toBe(true);
  });

  test("it works on a workspace whose reserved vocabularies another writer seeded under other ids (needs K2)", () => {
    expect(outSeeded.learn.isError).toBe(false);
    expect(outSeeded.learn.value.success).toBe(true);
    const head = outSeeded.head_learn.value;
    const seededIds = seeded.workspaces[SEEDED]!.vocabulary_ids;
    const type = JSON.parse(head.revision.term_snapshot_json).find((t: any) => t.vocabulary_name_snapshot === "type");
    expect(type.vocabulary_id).toBe(seededIds.type);
    expect(type.term_name_snapshot).toBe("learning");
  });
});

describe("refusals (V1 #3, #4, #9)", () => {
  test("a concept in a sealed vocabulary is an isError naming the concept, and nothing is published", () => {
    expect(out.operator[0]).toMatchObject({ ok: true });
    expect(out.sealed.isError).toBe(true);
    expect(out.sealed.value.compat.code).toBe("kernel_error");
    expect(out.sealed.value.error).toContain("never-created");
    expect(out.sealed_count_after.value.total).toBe(out.sealed_count_before.value.total);
  });

  test("a required vocabulary the adapter cannot fill is semantic_refusal, and nothing is published", () => {
    expect(out.operator[1]).toMatchObject({ ok: true });
    expect(out.required.isError).toBe(true);
    expect(out.required.value.compat.code).toBe("semantic_refusal");
    expect(Number(out.required_count.value.total)).toBe(0);
  });

  test("content over the 256 KiB MCP envelope is refused before any write", () => {
    expect(out.too_big.status).toBe(413);
    expect(Number(out.count_after.value.total)).toBe(Number(out.count_before_fail.value.total) + 1);
  });
});

describe("indexing never blocks the write (V1 #5)", () => {
  test("an indexing failure still succeeds with embedding:'failed', and reconcile reports the revision missing", () => {
    expect(out.index_fails.isError).toBe(false);
    expect(out.index_fails.value).toMatchObject({ success: true, embedding: "failed" });
    expect(typeof out.index_fails.value.embeddingError).toBe("string");
    expect(out.reconcile.isError).toBe(false);
    expect(JSON.stringify(out.reconcile.value.missing_revisions)).toContain(out.index_fails.value.v4.revision_id);
  });
});

describe("oracle_research_note (V1 #6)", () => {
  test("URL evidence is a supports/locator_only url link, repo+issue a discusses issue link, no persona tags", () => {
    const res = out.note;
    expect(res.isError).toBe(false);
    expect(res.value).toMatchObject({ success: true, file: null });
    expect(res.value.compat_warnings).toContainEqual(expect.objectContaining({ code: "semantic_change" }));
    const head = out.head_note.value;
    const links = JSON.parse(head.revision.link_snapshot_json);
    expect(links).toContainEqual(expect.objectContaining({ relation: "supports", target_kind: "url", target: { url: "https://lancedb.github.io/lancedb/fts/" }, capture_status: "locator_only", excerpt: "ngram tokenizer" }));
    expect(links).toContainEqual(expect.objectContaining({ relation: "discusses", target_kind: "issue", target: { repo: "soul-brews-studio/arra-oracle-v4", number: "10", url: "https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/10" } }));
    expect(termsOf(head, "type")).toEqual(["learning"]);
    expect(termsOf(head, "concepts")).toEqual(["dev-research", "fts"]);
    expect(head.revision.body).toContain("app/server/src/db.ts");
    expect(head.revision.body).not.toContain("stormforge");
  });
});

describe("oracle_research_note keeps the note when some evidence is not a v4 target", () => {
  test("a url the kernel would refuse is left in the body, not linked, and named in a partial warning", () => {
    const res = out.note_bad_url;
    expect(res.isError).toBe(false);
    expect(res.value).toMatchObject({ success: true, file: null });
    const head = out.head_note_bad_url.value;
    const links = JSON.parse(head.revision.link_snapshot_json);
    expect(links).toEqual([expect.objectContaining({ relation: "supports", target_kind: "url", target: { url: "https://example.org/ok" } })]);
    expect(head.revision.body).toContain("http://x y");
    expect(head.revision.body).toContain("https://user:pw@example.org/");
    const partial = res.value.compat_warnings.filter((w: any) => w.code === "partial");
    expect(partial.map((w: any) => w.field)).toEqual(["externalSources/0/url", "externalSources/2/url", "repo"]);
    for (const warning of partial) expect(typeof warning.detail).toBe("string");
  });
});

describe("oracle_handoff (V1 #7) and no server files (V1 #8)", () => {
  test("a handoff is a note tagged concepts:handoff and memory_horizon:short_term, authored by the bound speaker", () => {
    expect(out.handoff.value).toMatchObject({ success: true, file: null });
    const head = out.head_handoff.value;
    expect(head.revision.title).toBe("fleet-cleanup");
    expect(head.revision.author_peer_name).toBe("neo");
    expect(termsOf(head, "type")).toEqual(["note"]);
    expect(termsOf(head, "concepts")).toEqual(["handoff"]);
    expect(termsOf(head, "memory_horizon")).toEqual(["short_term"]);
  });

  test("with no speaker the author is null, never the principal; an unbound speaker is refused", () => {
    const head = out.head_handoff_anon.value;
    expect(head.revision.author_peer_name).toBeNull();
    expect(head.revision.title).toBe("Handoff: second");
    expect(out.handoff_unbound.isError).toBe(true);
    expect(out.handoff_unbound.value.compat.path).toBe("/peer");
  });

  test("the child's HOME and cwd are untouched: nothing is written outside the dataset", async () => {
    // R13: nothing is excluded. Bun's runtime transpiler cache used to be
    // (HOME/Library/Caches/bun on macOS), but on Linux it lands in
    // HOME/.bun/install/cache/@t@ and failed the GitHub run (36269825188).
    // runChild now turns that cache off, so ANY file here is a real write.
    expect(await readdir(home, { recursive: true })).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
  });
});
