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
import {
  CHUNKER_VERSION,
  chunkText,
  deriveChunkId,
  encodeSearchChunkRow,
  parseIndexRevision,
} from "../src/publication/search-chunk";
import { ContractError } from "../src/contracts/errors";
import { PublicationError } from "../src/publication/errors";

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

describe("F1: chunkText never splits a surrogate pair", () => {
  test("an emoji sitting exactly on the 1000-unit boundary stays intact", () => {
    // "a".repeat(999) is 999 UTF-16 units; the emoji's high surrogate lands
    // at index 999, exactly where a naive `slice(0, 1000)` would cut.
    const emoji = "\u{1F600}"; // 😀, a surrogate PAIR: 😀
    const text = "a".repeat(999) + emoji + "b".repeat(10);
    const chunks = chunkText(text, 1000);
    // The pair is never split across two chunks.
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          expect(i + 1).toBeLessThan(chunk.length);
          const next = chunk.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          expect(i).toBeGreaterThan(0);
          const prev = chunk.charCodeAt(i - 1);
          expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
        }
      }
    }
    // Concatenating the chunks losslessly reconstructs the original text --
    // the actual failure mode the review demonstrated (rejoin producing
    // U+FFFD replacement characters instead of the emoji).
    expect(chunks.join("")).toBe(text);
    expect(chunks.join("")).toContain(emoji);
  });
});

describe("F3: chunker_version is a closed grammar, not free text", () => {
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const request = (overrides: Record<string, unknown> = {}) => ({
    workspace_name: "alpha-workspace",
    node_id: pad("node1"),
    revision_id: pad("rev1"),
    chunker_version: CHUNKER_VERSION,
    embedding_profile: { name: "profile-a", dims: 384 },
    ...overrides,
  });

  test("the implemented constant is accepted; any other label is refused", () => {
    expect(parseIndexRevision(bytes(request())).chunker_version).toBe(CHUNKER_VERSION);
    let error: unknown;
    try {
      parseIndexRevision(bytes(request({ chunker_version: "chunker/v2" })));
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).toJSON()).toMatchObject({
      code: "invalid_value",
      path: "/chunker_version",
    });
  });
});

describe("F7: the stored codec accepts explicit null only, never undefined", () => {
  const validRow = () => ({
    id: "a".repeat(64),
    workspace_name: "alpha-workspace",
    node_id: pad("node1"),
    revision_id: pad("rev1"),
    chunk_index: 0n,
    text: "hello",
    content_hash: "b".repeat(64),
    chunker_version: CHUNKER_VERSION,
    embedding_profile: "profile-a",
    embedding: null,
    type_term_id: pad("term1"),
    term_ids: [pad("term1")],
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: null,
    status: "pending",
    attempts: 0n,
    last_attempt_at: null,
    embedded_at: null,
    error_code: null,
  });
  const corrupt = (row: Record<string, unknown>) => {
    let error: unknown;
    try {
      encodeSearchChunkRow(row);
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).code).toBe("integrity_failure");
  };

  test("valid row with explicit nulls encodes fine", () => {
    expect(encodeSearchChunkRow(validRow()).last_attempt_at).toBeNull();
  });

  test("undefined is refused, not read as null", () => {
    corrupt({ ...validRow(), last_attempt_at: undefined });
    corrupt({ ...validRow(), embedded_at: undefined });
    corrupt({ ...validRow(), term_ids: [undefined] });
    corrupt({ ...validRow(), embedding: undefined });
  });
});

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
          ctx("listSearchChunks", {
            workspace_name: ALPHA,
            revision_id: REV_A1,
            chunker_version: CHUNKER_VERSION,
            embedding_profile: PROFILE.name,
          }),
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

  test("F5: listSearchChunks is scoped to one embedding_profile, not merged across all of them", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, NODE_A, "op-pub-a1"),
          ctx("indexRevisionChunks", {
            ...indexRequest(NODE_A, REV_A1),
            embedding_profile: { name: "profile-a", dims: 384 },
          }),
          ctx("indexRevisionChunks", {
            ...indexRequest(NODE_A, REV_A1),
            embedding_profile: { name: "profile-b", dims: 384 },
          }),
          ctx("listSearchChunks", {
            workspace_name: ALPHA,
            revision_id: REV_A1,
            chunker_version: CHUNKER_VERSION,
            embedding_profile: "profile-a",
          }),
        ],
        { revisionIds: [REV_A1] },
      );
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      expect(parsed.op2.ok, JSON.stringify(parsed.op2)).toBe(true);

      // Both indexing runs produced a real row under their OWN profile.
      expect(parsed.op1.value.rows).toHaveLength(1);
      expect(parsed.op2.value.rows).toHaveLength(1);
      expect(parsed.op1.value.rows[0].id).not.toBe(parsed.op2.value.rows[0].id);

      // The list, scoped to profile-a, returns ONLY profile-a's row -- not
      // both profiles merged under one non-unique chunk_index.
      const listed = parsed.op3;
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0].embedding_profile).toBe("profile-a");
      expect(listed.value[0].id).toBe(parsed.op1.value.rows[0].id);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("F8: a snapshot with two reserved-type assignments is stored corruption, not a silent last-match pick", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const typeTerm = seeded.term_ids.type.note;
      const decisionTerm = seeded.term_ids.type.decision;
      // Two DIFFERENT terms in the SAME reserved "type" vocabulary --
      // unreachable through publishRevision (which requires exactly one),
      // planted directly to reach the stored state this guards against.
      const corruptedSnapshot = JSON.stringify([
        {
          term_id: typeTerm.id,
          vocabulary_id: typeTerm.vocabulary_id,
          vocabulary_name_snapshot: typeTerm.vocabulary_name,
          term_name_snapshot: typeTerm.name,
          label_snapshot: null,
          position: "0",
        },
        {
          term_id: decisionTerm.id,
          vocabulary_id: decisionTerm.vocabulary_id,
          vocabulary_name_snapshot: decisionTerm.vocabulary_name,
          term_name_snapshot: decisionTerm.name,
          label_snapshot: null,
          position: "1",
        },
      ]);
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, NODE_A, "op-pub-a1"),
          hx("corruptTermSnapshot", { revision_id: REV_A1, term_snapshot_json: corruptedSnapshot }),
          ctx("indexRevisionChunks", indexRequest(NODE_A, REV_A1)),
        ],
        { revisionIds: [REV_A1] },
      );
      expect(parsed.op0.ok).toBe(true);
      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      const indexed = parsed.op2;
      expect(indexed.ok).toBe(false);
      expect(indexed).toMatchObject({ code: "integrity_failure", path: "" });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("F2: the readback is scoped to the requesting workspace, not id alone", async () => {
    // Two workspaces, same fixture, with the SAME revision id forced in
    // each -- `deriveChunkId` does not key on workspace_name, so this is
    // the only way to make an id genuinely collide across workspaces. A
    // readback that matched on `id` alone would find TWO rows here and
    // poison with integrity_failure instead of succeeding, scoped, in ALPHA.
    const BETA = "beta-workspace";
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const parsed = await drive(
        fixture.datasetRoot,
        [
          { facade: "publication", method: "publishRevision", request: {
            operation_id: "op-pub-beta", content: revisionEnvelope(BETA, beta, NODE_A),
          } },
          ctx("indexRevisionChunks", { ...indexRequest(NODE_A, REV_A1), workspace_name: BETA }),
          publish(alpha, NODE_A, "op-pub-alpha"),
          ctx("indexRevisionChunks", indexRequest(NODE_A, REV_A1)),
        ],
        // Both publishes are handed the SAME revision id on purpose.
        { revisionIds: [REV_A1, REV_A1] },
      );
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      expect(parsed.op1.value.rows[0].workspace_name).toBe(BETA);
      expect(parsed.op2.ok, JSON.stringify(parsed.op2)).toBe(true);
      // The colliding id exists in BETA; ALPHA's own indexing still succeeds,
      // scoped, rather than tripping a spurious integrity_failure.
      const alphaIndexed = parsed.op3;
      expect(alphaIndexed.ok, JSON.stringify(alphaIndexed)).toBe(true);
      expect(alphaIndexed.value.outcome).toBe("indexed");
      expect(alphaIndexed.value.rows[0].workspace_name).toBe(ALPHA);
      expect(alphaIndexed.value.rows[0].id).toBe(parsed.op1.value.rows[0].id);
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
