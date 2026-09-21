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
 * MEASURED, NOT ASSUMED: at this base commit, `search-chunk.ts`'s own
 * `storedEmbeddingMustBeNull` unconditionally refuses a NON-null `embedding`
 * value, and no writer in this kernel ever populates one -- the "not-yet-
 * implemented" embed step search-chunk.ts's header describes. There is
 * therefore no real path to a POPULATED embedding to round-trip; "the
 * all-null embedding written and read back as genuinely null" is proven via
 * a real `indexRevisionChunks` call, and "a non-384 profile refused" is
 * proven at the REQUEST-GRAMMAR boundary (`parseIndexRevision`), which is
 * where this kernel actually enforces the frozen dimension -- there is no
 * separate stored-embedding-dimension check to exercise. This gap is
 * reported explicitly, not silently narrowed.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type SeededWorkspace } from "./helpers/publication-fixture";
import {
  CHUNKER_VERSION,
  deriveChunkId,
  parseIndexRevision,
  SEARCH_CHUNK_FIELDS,
} from "../src/publication/search-chunk";
import { ContractError } from "../src/contracts/errors";

const CHILD = new URL("./fixtures/search-chunk-v1/precision/seed-child.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
const TEST_TIMEOUT_MS = 600_000;
const INT64_CEILING = 9223372036854775807n; // 2^63 - 1
const PROFILE = { name: "test-profile", dims: 384 };

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
    embedding_profile: { name: "profile-a", dims },
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
