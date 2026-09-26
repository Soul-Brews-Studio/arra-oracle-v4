// K6+K7 (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18 (K6+K7+V8)):
// `listTermUsage` and `knowledgeStats` counting semantics, proved against an
// in-memory `DatasetAdapter` (`helpers/fakeDatasetAdapter.ts`). The real
// fixture, grammar and wire proofs stay in `taxonomy-term-usage-service.test.ts`;
// this file holds every test that needs row shapes a real fixture cannot
// cheaply produce: 1000+ node windows, a head whose derived projection was
// never reconciled, stale projection rows, stored corruption.
//
// Split out of `taxonomy-term-usage-service.test.ts` in the second fix round,
// which had grown past the 500-line cap.
//
// SECOND FIX ROUND (an independent verifier's blocking finding): the first two
// cuts of `listTermUsage` counted rows of the DERIVED `node_revision_terms`
// projection, so any accepted head nobody had reconciled yet -- every
// `kb_publishRevision`/HTTP/UI write -- was silently left out while
// `coverage` still said "full". The "authoritative source" block below was
// written BEFORE the fix and seen red: `rows: []` / `total_unique: "0"` /
// `coverage: "full"` for three unreconciled heads carrying apfs x2 + backup x1.

import { describe, expect, test } from "bun:test";
import { knowledgeStats } from "../src/publication/service.knowledgeStats";
import { listTermUsage } from "../src/publication/service.listTermUsage";
import { listTerms } from "../src/publication/service.listTerms";
import { fakeDatasetAdapter } from "./helpers/fakeDatasetAdapter";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const CONCEPTS = "vocabCONCEPTSAAAAAAAA";
const TYPE = "vocabTYPEAAAAAAAAAAAA";
const pad = (prefix: string, i: number) => `${prefix}${String(i).padStart(21 - prefix.length, "0")}`;

/** One accepted head revision's row: the reserved `type` entry plus one
 *  entry per concept, in the same shape `taxonomy.termSnapshot.ts` writes. */
function revision(id: string, workspace: string, type: string, concepts: string[]): Record<string, unknown> {
  const entries = [
    { term_id: `type-${type}`, vocabulary_id: TYPE, vocabulary_name_snapshot: "type", term_name_snapshot: type, label_snapshot: null, position: "0" },
    ...concepts.map((name, i) => ({
      term_id: `concept-${name}`,
      vocabulary_id: CONCEPTS,
      vocabulary_name_snapshot: "concepts",
      term_name_snapshot: name,
      label_snapshot: null,
      position: String(i + 1),
    })),
  ];
  return { id, workspace_name: workspace, term_snapshot_json: JSON.stringify(entries) };
}

/** `heads[i]` is node i's type and concepts; each node gets its OWN head
 *  revision (a shared revision across nodes cannot happen in a real dataset). */
function dataset(workspace: string, heads: { type: string; concepts: string[] }[]) {
  const nodes = heads.map((_, i) => ({
    id: pad(`${workspace}node`, i),
    workspace_name: workspace,
    current_revision_id: pad(`${workspace}rev`, i),
    updated_at: BigInt(1_700_000_000_000_000 + i * 1000),
  }));
  const node_revisions = heads.map((h, i) => revision(nodes[i]!.current_revision_id, workspace, h.type, h.concepts));
  return { nodes, node_revisions };
}

const usage = (workspace: string, type_term: string | null = null, limit = 10) =>
  bytes({ workspace_name: workspace, vocabulary_id: CONCEPTS, type_term, limit });

const errorOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return error as { code?: string; path?: string };
  }
  return "no error";
};

describe("listTermUsage counts the authoritative head snapshots, never the derived projection", () => {
  test("RED first: heads with ZERO node_revision_terms rows (never reconciled) are counted, and coverage full is then true", async () => {
    const { nodes, node_revisions } = dataset("ws", [
      { type: "learning", concepts: ["apfs", "backup"] },
      { type: "learning", concepts: ["apfs"] },
      { type: "note", concepts: [] },
    ]);
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], nodes, node_revisions, node_revision_terms: [] });
    const result = await listTermUsage(adapter, usage("ws"));
    expect(result).toEqual({
      rows: [
        { term_id: "concept-apfs", name: "apfs", count: "2" },
        { term_id: "concept-backup", name: "backup", count: "1" },
      ],
      total_unique: "2",
      coverage: "full",
    });
  });

  test("a stale projection row (a term the head no longer carries, or a non-head revision) cannot change the count", async () => {
    const { nodes, node_revisions } = dataset("ws", [{ type: "learning", concepts: ["apfs"] }]);
    const headId = nodes[0]!.current_revision_id;
    const projection = (revision_id: string, name: string) => ({
      workspace_name: "ws",
      revision_id,
      vocabulary_id: CONCEPTS,
      term_id: `concept-${name}`,
      term_name_snapshot: name,
    });
    const adapter = fakeDatasetAdapter({
      workspaces: [{ name: "ws" }],
      nodes,
      node_revisions,
      node_revision_terms: [projection(headId, "apfs"), projection(headId, "zfs"), projection("oldrevisionAAAAAAAAAA", "btrfs")],
    });
    const result = await listTermUsage(adapter, usage("ws"));
    expect(result.rows).toEqual([{ term_id: "concept-apfs", name: "apfs", count: "1" }]);
    expect(result.total_unique).toBe("1");
  });

  test("rows rank by count DESCENDING, then name ascending (kills M16, 'sorted by name only')", async () => {
    const { nodes, node_revisions } = dataset("ws", [
      { type: "learning", concepts: ["zfs", "bcachefs"] },
      { type: "learning", concepts: ["zfs", "apfs"] },
    ]);
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], nodes, node_revisions });
    const result = await listTermUsage(adapter, usage("ws"));
    // zfs(2) first even though it sorts LAST by name; the apfs/bcachefs tie
    // at 1 falls back to name order.
    expect(result.rows.map((r) => [r.name, r.count])).toEqual([["zfs", "2"], ["apfs", "1"], ["bcachefs", "1"]]);
  });

  test("total_unique counts every distinct term, not just the rows the limit kept", async () => {
    const { nodes, node_revisions } = dataset("ws", [{ type: "learning", concepts: ["apfs", "backup", "zfs"] }]);
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], nodes, node_revisions });
    const result = await listTermUsage(adapter, usage("ws", null, 1));
    expect(result.rows.length).toBe(1);
    expect(result.total_unique).toBe("3");
  });

  test("type_term actually excludes a differently-typed head (kills M2, 'ignore the type_term filter')", async () => {
    const { nodes, node_revisions } = dataset("ws", [
      { type: "learning", concepts: ["apfs"] },
      { type: "learning", concepts: ["apfs"] },
      { type: "note", concepts: ["apfs"] },
    ]);
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], nodes, node_revisions });
    expect((await listTermUsage(adapter, usage("ws"))).rows[0]?.count).toBe("3");
    expect((await listTermUsage(adapter, usage("ws", "learning"))).rows[0]?.count).toBe("2");
  });

  test("a duplicate term_id inside one stored head snapshot is integrity_failure, never double-counted", async () => {
    const { nodes, node_revisions } = dataset("ws", [{ type: "learning", concepts: ["apfs", "apfs"] }]);
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], nodes, node_revisions });
    expect(await errorOf(listTermUsage(adapter, usage("ws")))).toMatchObject({ code: "integrity_failure" });
  });

  test("a head pointer with no revision row is integrity_failure, not a quietly smaller count", async () => {
    const { nodes } = dataset("ws", [{ type: "learning", concepts: ["apfs"] }]);
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], nodes, node_revisions: [] });
    expect(await errorOf(listTermUsage(adapter, usage("ws")))).toMatchObject({ code: "integrity_failure" });
  });
});

describe("K6/K7 bounded scans: coverage/null, not a fabricated partial count", () => {
  const tagged = (count: number) => dataset("ws", Array.from({ length: count }, () => ({ type: "learning", concepts: ["apfs"] })));

  test("listTermUsage discloses coverage:partial once the node scan window is exceeded", async () => {
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], ...tagged(1001) });
    const result = await listTermUsage(adapter, usage("ws"));
    expect(result.coverage).toBe("partial");
    // The 1000-row window still counted whatever it saw -- a partial count
    // that says so, never a silently wrong "full".
    expect(result.rows[0]?.count).toBe("1000");
  });

  test("listTermUsage is full coverage at exactly the window size", async () => {
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], ...tagged(1000) });
    const result = await listTermUsage(adapter, usage("ws"));
    expect(result.coverage).toBe("full");
    expect(result.rows[0]?.count).toBe("1000");
  });

  test("knowledgeStats: by_type and last_updated_at are null (never a guessed partial) once the node window is exceeded", async () => {
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], ...tagged(1001) });
    const stats = await knowledgeStats(adapter, bytes({ workspace_name: "ws" }));
    expect(stats.nodes_total).toBe("1001");
    expect(stats.by_type).toBeNull();
    expect(stats.last_updated_at).toBeNull();
  });

  test("knowledgeStats: nodes_eligible is null once the supersede_log scan is exceeded, while nodes_total stays exact", async () => {
    const supersede_log = Array.from({ length: 2001 }, (_, i) => ({ workspace_name: "ws", old_id: `old${i}` }));
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], ...tagged(1), supersede_log });
    const stats = await knowledgeStats(adapter, bytes({ workspace_name: "ws" }));
    expect(stats.nodes_total).toBe("1");
    expect(stats.nodes_eligible).toBeNull();
    expect(stats.by_type).toEqual([{ term: "learning", count: "1" }]);
  });
});

// First fix round: an independent verifier's mutation pass found four
// surviving mutants (M2/M3/M4/M10). M2 is killed above; the other three below.
// Second fix round: the same pass found M12/M13/M14 (a scan or count with its
// workspace scope dropped) surviving, because the only isolation test compared
// two workspaces seeded identically. The isolation test below seeds DIFFERENT
// counts per workspace in every table knowledgeStats reads.
describe("knowledgeStats: exact counts (mutant kills)", () => {
  test("nodes_eligible subtracts exactly the terminal supersede rows, not the whole total (kills M3)", async () => {
    const supersede_log = [0, 1].map((i) => ({ workspace_name: "ws", old_id: pad("wsnode", i) }));
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], ...dataset("ws", Array.from({ length: 5 }, () => ({ type: "learning", concepts: [] }))), supersede_log });
    const stats = await knowledgeStats(adapter, bytes({ workspace_name: "ws" }));
    expect(stats.nodes_total).toBe("5");
    expect(stats.nodes_eligible).toBe("3");
  });

  test("a chunk group's count is exact, not doubled (kills M4)", async () => {
    const chunks = Array.from({ length: 3 }, () => ({ workspace_name: "ws", embedding_profile: "p1", status: "ready" }));
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], search_chunks_v1: chunks });
    const stats = await knowledgeStats(adapter, bytes({ workspace_name: "ws" }));
    expect(stats.chunks).toEqual([{ embedding_profile: "p1", status: "ready", count: "3" }]);
  });

  test("last_updated_at is the true MAXIMUM, not the minimum (kills M10)", async () => {
    const { nodes, node_revisions } = dataset("ws", [0, 1, 2].map(() => ({ type: "learning", concepts: [] })));
    const values = [1_700_000_000_100_000n, 1_700_000_000_900_000n, 1_700_000_000_500_000n];
    nodes.forEach((n, i) => (n.updated_at = values[i]!));
    const adapter = fakeDatasetAdapter({ workspaces: [{ name: "ws" }], nodes, node_revisions });
    const stats = await knowledgeStats(adapter, bytes({ workspace_name: "ws" }));
    expect(new Date(stats.last_updated_at!).getTime()).toBe(1_700_000_000_900);
  });

  test("isolation: two workspaces with DIFFERING rows in every table are each counted on their own (kills M12/M13/M14)", async () => {
    const alpha = dataset("alpha", [{ type: "learning", concepts: ["apfs"] }, { type: "learning", concepts: ["apfs"] }]);
    const beta = dataset("beta", [{ type: "note", concepts: ["apfs"] }]);
    const rows = (workspace: string, n: number, make: (i: number) => Record<string, unknown>) =>
      Array.from({ length: n }, (_, i) => ({ workspace_name: workspace, ...make(i) }));
    const adapter = fakeDatasetAdapter({
      workspaces: [{ name: "alpha" }, { name: "beta" }],
      nodes: [...alpha.nodes, ...beta.nodes],
      node_revisions: [...alpha.node_revisions, ...beta.node_revisions],
      // alpha: 2 chunks, 3 vocabularies, 11 terms, 1 superseded; beta: 3, 2, 10, 0.
      search_chunks_v1: [...rows("alpha", 2, () => ({ embedding_profile: "p1", status: "ready" })), ...rows("beta", 3, () => ({ embedding_profile: "p1", status: "ready" }))],
      vocabularies: [...rows("alpha", 3, (i) => ({ id: `va${i}` })), ...rows("beta", 2, (i) => ({ id: `vb${i}` }))],
      terms: [...rows("alpha", 11, (i) => ({ id: `ta${i}` })), ...rows("beta", 10, (i) => ({ id: `tb${i}` }))],
      supersede_log: rows("alpha", 1, () => ({ old_id: alpha.nodes[0]!.id })),
    });

    const a = await knowledgeStats(adapter, bytes({ workspace_name: "alpha" }));
    const b = await knowledgeStats(adapter, bytes({ workspace_name: "beta" }));
    expect([a.nodes_total, a.nodes_eligible, a.vocabularies, a.terms]).toEqual(["2", "1", "3", "11"]);
    expect([b.nodes_total, b.nodes_eligible, b.vocabularies, b.terms]).toEqual(["1", "1", "2", "10"]);
    expect(a.chunks).toEqual([{ embedding_profile: "p1", status: "ready", count: "2" }]);
    expect(b.chunks).toEqual([{ embedding_profile: "p1", status: "ready", count: "3" }]);
    expect(a.by_type).toEqual([{ term: "learning", count: "2" }]);
    expect(b.by_type).toEqual([{ term: "note", count: "1" }]);

    expect((await listTermUsage(adapter, usage("alpha"))).rows[0]?.count).toBe("2");
    expect((await listTermUsage(adapter, usage("beta"))).rows[0]?.count).toBe("1");
  });
});

describe("a workspace with no workspaces row is invalid_reference, like listNodes/listPeers/listSessions", () => {
  // Second fix round (verifier, nonblocking): these three skipped the
  // service-level workspace check, so a granted bank with no workspace row
  // answered exact-looking zeros instead of `invalid_reference`.
  const adapter = fakeDatasetAdapter({ workspaces: [{ name: "other" }] });

  test("listTermUsage", async () => {
    expect(await errorOf(listTermUsage(adapter, usage("ws")))).toMatchObject({ code: "invalid_reference", path: "/workspace_name" });
  });

  test("knowledgeStats", async () => {
    expect(await errorOf(knowledgeStats(adapter, bytes({ workspace_name: "ws" })))).toMatchObject({ code: "invalid_reference", path: "/workspace_name" });
  });

  test("listTerms", async () => {
    const request = bytes({ workspace_name: "ws", vocabulary_id: CONCEPTS, after_id: null, limit: 10, include_inactive: false });
    expect(await errorOf(listTerms(adapter, request))).toMatchObject({ code: "invalid_reference", path: "/workspace_name" });
  });
});
