/**
 * search-chunk-v1 precision evidence (`search_chunks_v1`).
 *
 * Scope, per the dispatch: `chunk_index` and `attempts` are int64 -- ceiling
 * behaviour exact. `last_attempt_at`/`embedded_at` are nullable
 * `timestamp[us]` -- explicit null only, sub-millisecond refused. The
 * embedding column is `fixed_size_list<float32?>[384]`: a non-384 profile is
 * refused, and the all-null embedding writes and reads back as genuinely
 * null. `term_ids` is `list<utf8?>`, the only list column -- an empty list, a
 * multi-element list, and a null element all survive exactly, decoded as an
 * Arrow Vector rather than a JS array. Deterministic chunk ids are
 * byte-stable across runs.
 *
 * #90 UPDATE: `storedEmbedding` (replacing `storedEmbeddingMustBeNull`) now
 * accepts a populated 384-float vector, and `service.writeChunkEmbedding.ts`
 * is a real write path for one, through the same owner/gate machinery as
 * every other mutator here. The gap the previous revision of this comment
 * reported -- "no real path to a POPULATED embedding to round-trip" -- is
 * closed below: a real `writeChunkEmbedding` call attaches a populated
 * vector to a row a real `indexRevisionChunks` call created, and the RAW
 * stored floats are compared, element-for-element, against `Math.fround` of
 * the values requested (float32 storage rounds a JS double on write; the
 * assertion must compare against that rounding, not the original double, or
 * it passes for the wrong reason).
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type SeededWorkspace } from "./helpers/publication-fixture";
import {
  activeEmbeddingProfileId,
  CHUNKER_VERSION,
  deriveChunkId,
  parseIndexRevision,
  SEARCH_CHUNK_FIELDS,
  storedEmbedding,
} from "../src/publication/search-chunk";
import { ContractError } from "../src/contracts/errors";
import { PublicationError } from "../src/publication/errors";

const CHILD = new URL("./fixtures/search-chunk-v1/precision/seed-child.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
const TEST_TIMEOUT_MS = 600_000;
const INT64_CEILING = 9223372036854775807n; // 2^63 - 1
// #30 R7: `indexRevisionChunks`/`listSearchChunks` now refuse any
// `embedding_profile` name outside the closed registry -- this file plants
// raw rows directly (never through `indexRevisionChunks`), so a raw row's
// `embedding_profile` still needs to equal the active id for the
// `listSearchChunks` reads in this file to find it.
const PROFILE = { name: activeEmbeddingProfileId(), dims: 384 };

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

const drive = async (
  root: string,
  ops: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> => {
  const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 1200)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 1200)}`);
  return JSON.parse(line);
};

/** A minimal valid raw row -- `listSearchChunks` needs only the workspace to
 *  exist, never a real node/revision, so precision reads plant directly. */
function rawChunkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a".repeat(64),
    workspace_name: ALPHA,
    node_id: pad("node1"),
    revision_id: pad("rev1"),
    chunk_index: "0",
    text: "hello",
    content_hash: "b".repeat(64),
    chunker_version: CHUNKER_VERSION,
    embedding_profile: PROFILE.name,
    type_term_id: pad("term1"),
    term_ids: [pad("term1")],
    status: "pending",
    attempts: "0",
    ...overrides,
  };
}

const listRequest = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  revision_id: pad("rev1"),
  chunker_version: CHUNKER_VERSION,
  embedding_profile: PROFILE.name,
  ...overrides,
});

describe("deterministic chunk ids are byte-stable, pure function only", () => {
  test("identical inputs produce the identical id across two independent calls", () => {
    const a = deriveChunkId(pad("rev1"), CHUNKER_VERSION, PROFILE.name, 0n);
    const b = deriveChunkId(pad("rev1"), CHUNKER_VERSION, PROFILE.name, 0n);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a changed chunk_index or embedding_profile changes the id", () => {
    const base = deriveChunkId(pad("rev1"), CHUNKER_VERSION, PROFILE.name, 0n);
    expect(deriveChunkId(pad("rev1"), CHUNKER_VERSION, PROFILE.name, 1n)).not.toBe(base);
    expect(deriveChunkId(pad("rev1"), CHUNKER_VERSION, "other-profile", 0n)).not.toBe(base);
  });
});

describe("embedding_profile.dims is frozen at 384, refused at the request boundary", () => {
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const request = (dims: number) => ({
    workspace_name: ALPHA,
    node_id: pad("node1"),
    revision_id: pad("rev1"),
    chunker_version: CHUNKER_VERSION,
    // The active id, not an arbitrary name: the name check now runs BEFORE
    // the dims check (`search-chunk.embeddingProfile.ts`), so this dims-only
    // test needs a registered name or it would fail on the wrong field.
    embedding_profile: { name: PROFILE.name, dims },
  });

  test("384 is accepted; 383 and 385 are refused at /embedding_profile/dims", () => {
    expect(parseIndexRevision(bytes(request(384))).embedding_profile.dims).toBe(384);
    for (const bad of [383, 385, 0, -384]) {
      let error: unknown;
      try {
        parseIndexRevision(bytes(request(bad)));
        throw new Error("expected a throw, got none");
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).toJSON()).toMatchObject({
        code: "invalid_value", path: "/embedding_profile/dims",
      });
    }
  });
});

describe("a real index writes a genuinely null embedding, omitted from the wire", () => {
  test("all 19 wire fields (minus embedding) round-trip; the raw stored embedding is explicit null", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const revId = pad("revIdx1");
      const parsed = await drive(fixture.datasetRoot, [
        pub("publishRevision", { operation_id: "op-idx", content: revisionEnvelope(ALPHA, seeded, pad("nodeIdx1")) }),
        ctx("indexRevisionChunks", {
          workspace_name: ALPHA, node_id: pad("nodeIdx1"), revision_id: revId,
          chunker_version: CHUNKER_VERSION, embedding_profile: PROFILE,
        }),
        hx("readRawRows", { table: "search_chunks_v1", predicate: `workspace_name = '${ALPHA}' AND revision_id = '${revId}'` }),
      ], { revisionIds: [revId] });

      const indexed = parsed.op1;
      expect(indexed.ok, JSON.stringify(indexed)).toBe(true);
      expect(indexed.value.outcome).toBe("indexed");
      const row = indexed.value.rows[0] as Record<string, unknown>;
      expect(Object.keys(row)).toEqual((SEARCH_CHUNK_FIELDS as readonly string[]).filter((f) => f !== "embedding"));
      expect("embedding" in row).toBe(false);

      const raw = parsed.op2.value as Record<string, unknown>[];
      expect(raw).toHaveLength(1);
      // Explicit null, present column -- not merely absent from a projection.
      expect(raw[0]!.embedding).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("storedEmbedding: null or exactly 384 finite floats, pure function only", () => {
  const vec384 = (fill: number) => Array.from({ length: 384 }, () => fill);

  test("null is accepted as-is", () => {
    expect(storedEmbedding(null)).toBeNull();
  });

  test("a 384-element array of finite numbers is accepted, values unchanged", () => {
    const values = vec384(0.5);
    expect(storedEmbedding(values)).toEqual(values);
  });

  test("an Arrow-vector-like object exposing toArray() is accepted, matching storedTermIds's two-shape rule", () => {
    const values = vec384(-1.25);
    const vectorLike = { toArray: () => values };
    expect(storedEmbedding(vectorLike)).toEqual(values);
  });

  test("383 or 385 elements is refused -- the dimension is frozen, never truncated or padded", () => {
    expect(() => storedEmbedding(vec384(0).slice(0, 383))).toThrow(PublicationError);
    expect(() => storedEmbedding([...vec384(0), 0])).toThrow(PublicationError);
    try {
      storedEmbedding(vec384(0).slice(0, 383));
      throw new Error("expected a throw, got none");
    } catch (error) {
      expect((error as PublicationError).code).toBe("integrity_failure");
    }
  });

  test("NaN or Infinity anywhere in the vector is refused", () => {
    expect(() => storedEmbedding([...vec384(0).slice(0, 383), NaN])).toThrow(PublicationError);
    expect(() => storedEmbedding([...vec384(0).slice(0, 383), Infinity])).toThrow(PublicationError);
  });

  test("a non-array, non-toArray value is refused", () => {
    expect(() => storedEmbedding("not a vector")).toThrow(PublicationError);
    expect(() => storedEmbedding(42)).toThrow(PublicationError);
  });
});

describe("#90: a real write path attaches a populated embedding through the real owner/gate machinery", () => {
  const dims = (...fills: number[]): number[] => {
    // 384 values built from a short pattern of boundary cases, repeated to
    // fill the frozen dimension -- every element still individually
    // distinct enough (index-perturbed) that a transposition bug would show.
    const out: number[] = [];
    for (let i = 0; i < 384; i++) out.push(fills[i % fills.length]! + i * 1e-7);
    return out;
  };
  // Boundary values per the dispatch: 0, negative, very small, very large.
  const BOUNDARY_EMBEDDING = dims(0, -1, 1.5e-38, 3.4e38, -3.4e38, 1e-30);

  test("write -> read back: the raw stored floats equal Math.fround of what was written, element-for-element", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const revId = pad("revIdx2");
      const indexed = await drive(fixture.datasetRoot, [
        pub("publishRevision", { operation_id: "op-idx2", content: revisionEnvelope(ALPHA, seeded, pad("nodeIdx2")) }),
        ctx("indexRevisionChunks", {
          workspace_name: ALPHA, node_id: pad("nodeIdx2"), revision_id: revId,
          chunker_version: CHUNKER_VERSION, embedding_profile: PROFILE,
        }),
      ], { revisionIds: [revId] });
      expect(indexed.op1.ok, JSON.stringify(indexed.op1)).toBe(true);
      const chunkId = (indexed.op1.value.rows[0] as Record<string, unknown>).id as string;

      const parsed = await drive(fixture.datasetRoot, [
        ctx("writeChunkEmbedding", { workspace_name: ALPHA, id: chunkId, embedding: BOUNDARY_EMBEDDING }),
        hx("readRawRows", { table: "search_chunks_v1", predicate: `workspace_name = '${ALPHA}' AND id = '${chunkId}'` }),
      ], { revisionIds: [revId] });

      const embedded = parsed.op0;
      expect(embedded.ok, JSON.stringify(embedded)).toBe(true);
      expect(embedded.value.outcome).toBe("embedded");
      // Never on the wire, populated or not -- see `encodeSearchChunkRow`.
      expect("embedding" in embedded.value.row).toBe(false);
      expect(embedded.value.row.status).toBe("ready");
      expect(embedded.value.row.attempts).toBe("1");
      expect(embedded.value.row.embedded_at).not.toBeNull();
      expect(embedded.value.row.last_attempt_at).not.toBeNull();
      expect(embedded.value.row.error_code).toBeNull();

      const raw = parsed.op1.value as Record<string, unknown>[];
      expect(raw).toHaveLength(1);
      const storedVector = raw[0]!.embedding as number[];
      expect(storedVector).toHaveLength(384);
      // float32, not float64: storage rounds every JS double to its float32
      // representation on write. `Math.fround` is the float32 rounding the
      // Arrow Float32Array applied, so this compares against exactly that --
      // NOT the original double, which would fail this assertion for the
      // wrong reason on any of the boundary values above.
      for (let i = 0; i < 384; i++) {
        expect(storedVector[i]).toBe(Math.fround(BOUNDARY_EMBEDDING[i]!));
      }
      // The requested doubles are NOT all already float32-exact (this is
      // what proves the comparison above is doing real work, not
      // vacuously passing because rounding was a no-op).
      expect(BOUNDARY_EMBEDDING.some((v, i) => v !== Math.fround(v))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a dimension mismatch (383 or 385) is refused at the request boundary, not truncated or padded", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const revId = pad("revIdx3");
      const indexed = await drive(fixture.datasetRoot, [
        pub("publishRevision", { operation_id: "op-idx3", content: revisionEnvelope(ALPHA, seeded, pad("nodeIdx3")) }),
        ctx("indexRevisionChunks", {
          workspace_name: ALPHA, node_id: pad("nodeIdx3"), revision_id: revId,
          chunker_version: CHUNKER_VERSION, embedding_profile: PROFILE,
        }),
      ], { revisionIds: [revId] });
      const chunkId = (indexed.op1.value.rows[0] as Record<string, unknown>).id as string;

      for (const bad of [BOUNDARY_EMBEDDING.slice(0, 383), [...BOUNDARY_EMBEDDING, 0]]) {
        const parsed = await drive(fixture.datasetRoot, [
          ctx("writeChunkEmbedding", { workspace_name: ALPHA, id: chunkId, embedding: bad }),
        ], { revisionIds: [revId] });
        expect(parsed.op0.ok).toBe(false);
        expect(parsed.op0).toMatchObject({ code: "invalid_value", path: "/embedding" });
      }

      // Refused, not partially applied: the row is still `pending`, and a
      // correctly-sized vector can still embed it afterward.
      const stillPending = await drive(fixture.datasetRoot, [
        hx("readRawRows", { table: "search_chunks_v1", predicate: `workspace_name = '${ALPHA}' AND id = '${chunkId}'` }),
      ]);
      expect((stillPending.op0.value as Record<string, unknown>[])[0]!.status).toBe("pending");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("re-embedding a row that is already ready is refused at /id, not silently overwritten", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const revId = pad("revIdx4");
      const indexed = await drive(fixture.datasetRoot, [
        pub("publishRevision", { operation_id: "op-idx4", content: revisionEnvelope(ALPHA, seeded, pad("nodeIdx4")) }),
        ctx("indexRevisionChunks", {
          workspace_name: ALPHA, node_id: pad("nodeIdx4"), revision_id: revId,
          chunker_version: CHUNKER_VERSION, embedding_profile: PROFILE,
        }),
      ], { revisionIds: [revId] });
      const chunkId = (indexed.op1.value.rows[0] as Record<string, unknown>).id as string;

      const first = await drive(fixture.datasetRoot, [
        ctx("writeChunkEmbedding", { workspace_name: ALPHA, id: chunkId, embedding: BOUNDARY_EMBEDDING }),
      ], { revisionIds: [revId] });
      expect(first.op0.ok, JSON.stringify(first.op0)).toBe(true);

      const second = await drive(fixture.datasetRoot, [
        ctx("writeChunkEmbedding", { workspace_name: ALPHA, id: chunkId, embedding: dims(9) }),
      ], { revisionIds: [revId] });
      expect(second.op0.ok).toBe(false);
      expect(second.op0).toMatchObject({ code: "invalid_reference", path: "/id" });

      const unchanged = await drive(fixture.datasetRoot, [
        hx("readRawRows", { table: "search_chunks_v1", predicate: `workspace_name = '${ALPHA}' AND id = '${chunkId}'` }),
      ]);
      const storedVector = (unchanged.op0.value as Record<string, unknown>[])[0]!.embedding as number[];
      expect(storedVector[0]).toBe(Math.fround(BOUNDARY_EMBEDDING[0]!));
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("chunk_index and attempts: int64 at the ceiling", () => {
  test("both render as exact decimal TEXT at INT64_CEILING", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        hx("insertRawChunk", { rows: [rawChunkRow({
          chunk_index: INT64_CEILING.toString(10), attempts: INT64_CEILING.toString(10),
        })] }),
        ctx("listSearchChunks", listRequest()),
      ]);
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      const listed = parsed.op1;
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0].chunk_index).toBe(INT64_CEILING.toString(10));
      expect(listed.value[0].attempts).toBe(INT64_CEILING.toString(10));
      expect(typeof listed.value[0].chunk_index).toBe("string");
      expect(typeof listed.value[0].attempts).toBe("string");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("last_attempt_at / embedded_at: explicit null only, sub-millisecond refused", () => {
  test("both null is a valid row; a sub-millisecond remainder fails closed", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const okParsed = await drive(fixture.datasetRoot, [
        hx("insertRawChunk", { rows: [rawChunkRow({ id: "a".repeat(64) })] }),
        ctx("listSearchChunks", listRequest()),
      ]);
      expect(okParsed.op1.ok, JSON.stringify(okParsed.op1)).toBe(true);
      expect(okParsed.op1.value[0].last_attempt_at).toBeNull();
      expect(okParsed.op1.value[0].embedded_at).toBeNull();
    } finally {
      await fixture.cleanup();
    }

    const fixture2 = await createFixture([ALPHA]);
    try {
      const micros = (BigInt(CLOCK) * 1000n + 1n).toString(10);
      const parsed = await drive(fixture2.datasetRoot, [
        hx("insertRawChunk", { rows: [rawChunkRow({ id: "c".repeat(64), last_attempt_at_micros: micros })] }),
        ctx("listSearchChunks", listRequest()),
      ]);
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      expect(parsed.op1.ok).toBe(false);
      expect(parsed.op1).toMatchObject({
        name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
      });
    } finally {
      await fixture2.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("term_ids: the only list column, decoded as an Arrow Vector", () => {
  test("an empty list, a multi-element list, and a null element all survive exactly", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const cases: [string, (string | null)[]][] = [
        ["d".repeat(64), []],
        ["e".repeat(64), [pad("termA"), pad("termB"), pad("termC")]],
        ["f".repeat(64), [pad("termA"), null, pad("termB")]],
      ];
      const parsed = await drive(fixture.datasetRoot, [
        hx("insertRawChunk", { rows: cases.map(([id, term_ids]) => rawChunkRow({ id, chunk_index: "0", term_ids })) }),
        hx("readRawRows", { table: "search_chunks_v1", predicate: `workspace_name = '${ALPHA}'` }),
      ]);
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      const raw = parsed.op1.value as Record<string, unknown>[];
      const byId = new Map(raw.map((r) => [r.id as string, r]));
      expect(byId.get("d".repeat(64))!.term_ids).toEqual([]);
      expect(byId.get("e".repeat(64))!.term_ids).toEqual([pad("termA"), pad("termB"), pad("termC")]);
      expect(byId.get("f".repeat(64))!.term_ids).toEqual([pad("termA"), null, pad("termB")]);
      // MEASURED, per the accepted core lane: the generic Arrow decode hands
      // back a raw Vector, not a plain JS array, for this column.
      for (const [, row] of byId) {
        expect(row.term_ids_raw_shape).toEqual({
          typeofValue: "object", constructorName: "Vector", isArray: false, hasToArray: true,
        });
      }
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("status: a closed set this MODULE decides, not a stored enum", () => {
  test("a stored value outside pending/ready/failed is engine-admitted corruption, refused on read", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        hx("insertRawChunk", { rows: [rawChunkRow({ status: "archived" })] }),
        ctx("listSearchChunks", listRequest()),
      ]);
      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      expect(parsed.op1.ok).toBe(false);
      expect(parsed.op1).toMatchObject({
        name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
      });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
