/**
 * #30 search-chunk kernel — one minimal smoke test.
 *
 * Not an exhaustive suite: index a revision, prove the rows it produces,
 * prove a re-index is idempotent, prove list agrees, and prove reconcile can
 * see a genuinely missing revision. Modelled on the #71 read-cursor kernel's
 * real-persistence lane (`read-cursor-service.test.ts`), reusing the accepted
 * publication fixture rather than a second dataset creator.
 */

import { describe, expect, test } from "bun:test";
import {
  createFixture,
  revisionEnvelope,
  runGated,
  type SeededWorkspace,
} from "./helpers/publication-fixture";
import { deriveChunkId } from "../src/publication/search-chunk";

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

describe("preflight: the required surface", () => {
  test("the pure module exists and exports its grammar", async () => {
    const mod = await import("../src/publication/search-chunk").catch((error) => ({
      __absent: String(error),
    }));
    expect(mod).not.toHaveProperty("__absent");
    const m = mod as Record<string, unknown>;
    expect(typeof m.parseIndexRevision).toBe("function");
    expect(typeof m.parseReconcileSearch).toBe("function");
    expect(typeof m.parseListChunks).toBe("function");
    expect(typeof m.encodeSearchChunkRow).toBe("function");
    expect(typeof m.deriveChunkId).toBe("function");
    expect(m.CHUNK_STATUSES).toEqual(["pending", "ready", "failed"]);
  });

  test("the writer factory exposes the new context methods", async () => {
    const fixture = await createFixture(["alpha-workspace"]);
    try {
      const service = await import("../src/publication/service");
      const bundle = await service.openContextReader(fixture.datasetRoot);
      expect(Object.keys(bundle.context)).toContain("listSearchChunks");
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});

describe("real persistence: search chunks inside the real gate", () => {
  const CHILD = new URL("./fixtures/search-chunk-v1/core/gated-search.ts", import.meta.url).pathname;
  const ALPHA = "alpha-workspace";
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
  const NODE_A = pad("nodeA");
  const NODE_B = pad("nodeB");
  const REV_A1 = pad("revA1");
  const REV_B1 = pad("revB1");
  const CHUNKER_VERSION = "chunker/v1";
  const PROFILE = { name: "test-profile", dims: 384 };

  const drive = async (
    root: string,
    ops: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
    return JSON.parse(line);
  };
  const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
  const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
  const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

  const publish = (seeded: SeededWorkspace, node: string, operation: string) =>
    pub("publishRevision", {
      operation_id: operation,
      content: revisionEnvelope(ALPHA, seeded, node),
    });

  const indexRequest = (node: string, revision: string) => ({
    workspace_name: ALPHA,
    node_id: node,
    revision_id: revision,
    chunker_version: CHUNKER_VERSION,
    embedding_profile: PROFILE,
  });

  test("index -> pending rows with null embedding and deterministic ids; re-index is idempotent; list agrees", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, NODE_A, "op-pub-a1"),
          ctx("indexRevisionChunks", indexRequest(NODE_A, REV_A1)),
          // Re-index: same (revision, chunker_version, embedding_profile).
          ctx("indexRevisionChunks", indexRequest(NODE_A, REV_A1)),
          ctx("listSearchChunks", { workspace_name: ALPHA, revision_id: REV_A1 }),
          hx("readRawRows", {
            table: "search_chunks_v1",
            predicate: `workspace_name = '${ALPHA}' AND revision_id = '${REV_A1}'`,
          }),
        ],
        { revisionIds: [REV_A1] },
      );

      const published = parsed.op0;
      expect(published.ok, JSON.stringify(published)).toBe(true);
      expect(published.value.outcome).toBe("accepted");

      const indexed = parsed.op1;
      expect(indexed.ok, JSON.stringify(indexed)).toBe(true);
      expect(indexed.value.outcome).toBe("indexed");
      expect(indexed.value.rows).toHaveLength(1);
      const row = indexed.value.rows[0];

      // Deterministic id: a pure function of (revision, chunker, profile, index).
      const expectedId = deriveChunkId(REV_A1, CHUNKER_VERSION, PROFILE.name, 0n);
      expect(row.id).toBe(expectedId);
      expect(row.chunk_index).toBe("0");
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe("0");
      expect(row.last_attempt_at).toBeNull();
      expect(row.embedded_at).toBeNull();
      expect(row.error_code).toBeNull();
      // `embedding` is never on the wire, whether null or populated.
      expect("embedding" in row).toBe(false);
      // The type term, taken from the revision's own immutable snapshot.
      expect(row.type_term_id).toBe(seeded.term_ids.type.note.id);
      expect(row.term_ids).toEqual([seeded.term_ids.type.note.id]);

      // Re-index: SAME id, no duplicate row, reported as already_satisfied.
      const reindexed = parsed.op2;
      expect(reindexed.ok, JSON.stringify(reindexed)).toBe(true);
      expect(reindexed.value.outcome).toBe("already_satisfied");
      expect(reindexed.value.rows).toEqual(indexed.value.rows);

      // list agrees with what indexing produced.
      const listed = parsed.op3;
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      expect(listed.value).toEqual(indexed.value.rows);

      // Exactly ONE physical row: the re-index did not append a duplicate.
      const raw = parsed.op4.value;
      expect(raw).toHaveLength(1);
      expect(raw[0].id).toBe(expectedId);

      // EMPIRICAL: the list<utf8?> column does NOT come back from the
      // accepted `decodeArrowRows` generic fallback as a plain JS array --
      // it comes back as a raw apache-arrow `Vector` (typeof "object",
      // Array.isArray === false), exposing `.toArray()`. The harness records
      // that shape here rather than silently normalizing it away, and
      // `encodeSearchChunkRow`'s own `storedTermIds` is what actually
      // recovers a plain string array (see op1/op3 above, which already
      // prove the SERVICE-level round trip works via that codec).
      expect(raw[0].term_ids_raw_shape).toEqual({
        typeofValue: "object",
        constructorName: "Vector",
        isArray: false,
        hasToArray: true,
      });
      expect(raw[0].term_ids).toEqual([seeded.term_ids.type.note.id]);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("reconcile reports a missing revision and none for an indexed one", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, NODE_A, "op-pub-a1"),
          publish(seeded, NODE_B, "op-pub-b1"),
          ctx("indexRevisionChunks", indexRequest(NODE_A, REV_A1)),
          // NODE_B is published but never indexed.
          ctx("reconcileSearchChunks", { workspace_name: ALPHA, limit: 1024 }),
        ],
        { revisionIds: [REV_A1, REV_B1] },
      );

      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      expect(parsed.op2.ok, JSON.stringify(parsed.op2)).toBe(true);

      const reconciled = parsed.op3;
      expect(reconciled.ok, JSON.stringify(reconciled)).toBe(true);
      expect(reconciled.value.visited).toBe(2);
      expect(reconciled.value.missing).toBe(1);
      expect(reconciled.value.missing_revisions).toEqual([{ node_id: NODE_B, revision_id: REV_B1 }]);
      expect(reconciled.value.stale).toBe(0);
      expect(reconciled.value.exhausted).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("an unresolvable node or revision is invalid_reference, at the right pointer", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, NODE_A, "op-pub-a1"),
          ctx("indexRevisionChunks", indexRequest(pad("ghost-node"), REV_A1)),
          ctx("indexRevisionChunks", indexRequest(NODE_A, pad("ghost-rev"))),
        ],
        { revisionIds: [REV_A1] },
      );
      expect(parsed.op1.ok).toBe(false);
      expect(parsed.op1).toMatchObject({ code: "invalid_reference", path: "/node_id" });
      expect(parsed.op2.ok).toBe(false);
      expect(parsed.op2).toMatchObject({ code: "invalid_reference", path: "/revision_id" });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});
