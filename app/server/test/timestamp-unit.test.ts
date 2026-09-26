/**
 * #105 latent hazard — the micros validators must never accept a JS `number`.
 *
 * Every physical `timestamp[us]` column is read through `decodeArrowRows` /
 * `rawRows` (storage.ts), which return the raw microsecond `BigInt64Array`
 * value as a `bigint`. Every write path builds its `created_at`/etc. as
 * `BigInt(clock()) * 1000n` (see `service.registerNamed.ts` and siblings) or
 * converts a wire string through `timestampToMicros`, which also returns a
 * `bigint`. No production caller of the functions below ever legitimately
 * holds a plain JS `number` at this layer -- the ONLY thing that produces one
 * is the client's lossy `toArray()`/`.get()` accessor, which returns
 * MILLISECONDS (LANCEDB-FACTS.md §1), not microseconds. Before this fix, every
 * one of these validators accepted a safe-integer `number` and treated it AS
 * microseconds, which mislabels a millisecond value 1000x too small and
 * silently produces a wrong date instead of failing closed -- measured here
 * the same way `.tmp/understand/issue-105/number-hazard.ts` did: a
 * whole-second millisecond value passes the downstream "no sub-millisecond
 * remainder" check even when misread as microseconds, so
 * `storedTimestamp(1789982519000)` returned `"1970-01-21T17:13:02.519Z"`
 * instead of throwing. (A non-whole-second value like `1789982519383` would
 * already throw from the remainder check alone in several of these
 * functions, which would make the test pass for the wrong reason.)
 *
 * This file enumerates every one of those validators (context.rawMicros.ts,
 * taxonomy.rawMicros.ts, service.rawMicrosOf.ts, rows.ts's local `rawMicros`,
 * search-chunk.storedNullableTimestamp.ts, trace.storedMicrosTimestampOrNull.ts,
 * and the three private `storedTimestamp` copies in session-link.ts,
 * read-cursor.ts and lifecycle.ts) and proves each one now rejects a `number`
 * with `integrity_failure`, while still accepting the `bigint` shape every
 * real caller supplies. It also proves `storage.ts`'s raw-decode fallback no
 * longer manufactures a "microseconds" `bigint` out of a lossy millisecond
 * read when the underlying Arrow buffer's raw values are unavailable.
 */

import { describe, expect, test } from "bun:test";
import { Type } from "apache-arrow";
import { rawMicros as contextRawMicros } from "../src/publication/context.rawMicros";
import { storedTimestamp as contextStoredTimestamp } from "../src/publication/context.storedTimestamp";
import { rawMicros as taxonomyRawMicros } from "../src/publication/taxonomy.rawMicros";
import { storedTimestamp as taxonomyStoredTimestamp } from "../src/publication/taxonomy.storedTimestamp";
import { rawMicrosOf } from "../src/publication/service.rawMicrosOf";
import { storedNullableTimestamp as searchChunkStoredNullableTimestamp } from "../src/publication/search-chunk.storedNullableTimestamp";
import { storedMicrosTimestampOrNull } from "../src/publication/trace.storedMicrosTimestampOrNull";
import { encodeNodeRow } from "../src/publication/rows";
import { encodeSessionLinkRow } from "../src/publication/session-link";
import { validateWorkspaceRow } from "../src/publication/read-cursor";
import { encodeSupersedeLogRow } from "../src/publication/lifecycle";
import { decodeArrowRows } from "../src/publication/storage";
import { PublicationError } from "../src/publication/errors";
import { TaxonomyError } from "../src/publication/taxonomy.TaxonomyError";

/** A lossy `toArray()` millisecond read, mistaken for raw microseconds.
 *  Deliberately a WHOLE SECOND (divisible by 1000) so misreading it as
 *  microseconds passes every downstream "no sub-ms remainder" check too --
 *  otherwise several of these functions would incidentally throw from that
 *  unrelated check and the type hazard itself would go unproven. */
const MS_MISTAKEN_FOR_US = 1789982519000;
/** A legitimate raw microsecond `bigint` for the SAME wall-clock instant. */
const VALID_MICROS = 1789982519000000n;
const EXPECTED_ISO = "2026-09-21T09:21:59.000Z";

const throwsIntegrityFailure = (run: () => unknown, ErrorClass: new (...args: never[]) => Error) => {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ErrorClass);
  expect((thrown as { code?: string }).code).toBe("integrity_failure");
};

describe("micros validators reject a JS number (#105 latent hazard)", () => {
  test("context.rawMicros: bigint OK, number rejected", () => {
    expect(contextRawMicros(VALID_MICROS)).toBe(VALID_MICROS);
    throwsIntegrityFailure(() => contextRawMicros(MS_MISTAKEN_FOR_US), PublicationError);
  });

  test("context.storedTimestamp: the exact issue-105 repro must throw, not return 1970-01-21", () => {
    expect(contextStoredTimestamp(VALID_MICROS)).toBe(EXPECTED_ISO);
    throwsIntegrityFailure(() => contextStoredTimestamp(MS_MISTAKEN_FOR_US), PublicationError);
  });

  test("taxonomy.rawMicros: bigint OK, number rejected", () => {
    expect(taxonomyRawMicros(VALID_MICROS)).toBe(VALID_MICROS);
    throwsIntegrityFailure(() => taxonomyRawMicros(MS_MISTAKEN_FOR_US), TaxonomyError);
  });

  test("taxonomy.storedTimestamp: bigint OK, number rejected", () => {
    expect(taxonomyStoredTimestamp(VALID_MICROS)).toBe(EXPECTED_ISO);
    throwsIntegrityFailure(() => taxonomyStoredTimestamp(MS_MISTAKEN_FOR_US), TaxonomyError);
  });

  test("service.rawMicrosOf: bigint OK, number rejected", () => {
    expect(rawMicrosOf(VALID_MICROS)).toBe(VALID_MICROS);
    throwsIntegrityFailure(() => rawMicrosOf(MS_MISTAKEN_FOR_US), PublicationError);
  });

  test("search-chunk.storedNullableTimestamp: null/bigint OK, number rejected", () => {
    expect(searchChunkStoredNullableTimestamp(null)).toBeNull();
    expect(searchChunkStoredNullableTimestamp(VALID_MICROS)).toBe(EXPECTED_ISO);
    throwsIntegrityFailure(() => searchChunkStoredNullableTimestamp(MS_MISTAKEN_FOR_US), PublicationError);
  });

  test("trace.storedMicrosTimestampOrNull: null/bigint OK, number rejected", () => {
    expect(storedMicrosTimestampOrNull(null)).toBeNull();
    expect(storedMicrosTimestampOrNull(VALID_MICROS)).toBe(EXPECTED_ISO);
    throwsIntegrityFailure(() => storedMicrosTimestampOrNull(MS_MISTAKEN_FOR_US), PublicationError);
  });

  test("rows.ts's private rawMicros (via encodeNodeRow): bigint OK, number rejected", () => {
    const row = (createdAt: unknown) => ({
      id: "node-1",
      workspace_name: "ws",
      current_revision_id: null,
      created_at: createdAt,
      updated_at: createdAt,
    });
    expect(encodeNodeRow(row(VALID_MICROS)).created_at).toBe(EXPECTED_ISO);
    throwsIntegrityFailure(() => encodeNodeRow(row(MS_MISTAKEN_FOR_US)), PublicationError);
  });

  test("session-link.ts's private storedTimestamp (via encodeSessionLinkRow): bigint OK, number rejected", () => {
    const row = (createdAt: unknown) => ({
      id: "c".repeat(21),
      workspace_name: "ws",
      from_session_name: "s1",
      to_session_name: "s2",
      relation: "related_to",
      evidence_ref: null,
      created_by_peer_name: null,
      created_at: createdAt,
    });
    expect(encodeSessionLinkRow(row(VALID_MICROS)).created_at).toBe(EXPECTED_ISO);
    throwsIntegrityFailure(() => encodeSessionLinkRow(row(MS_MISTAKEN_FOR_US)), PublicationError);
  });

  test("read-cursor.ts's private storedTimestamp (via validateWorkspaceRow): bigint OK, number rejected", () => {
    const row = (createdAt: unknown) => ({
      id: "ws-1",
      name: "default",
      created_at: createdAt,
      h_metadata: null,
      internal_metadata: null,
      configuration: null,
      mission: null,
    });
    expect(validateWorkspaceRow(row(VALID_MICROS)).created_at).toBe(EXPECTED_ISO);
    // This is the exact #75 shape: a workspace row whose created_at came from
    // a lossy read would previously be silently rescaled instead of refused.
    throwsIntegrityFailure(() => validateWorkspaceRow(row(MS_MISTAKEN_FOR_US)), PublicationError);
  });

  test("lifecycle.ts's private storedTimestamp (via encodeSupersedeLogRow): bigint OK, number rejected", () => {
    const row = (supersededAt: unknown) => ({
      id: 1n,
      workspace_name: "ws",
      old_id: "a".repeat(21),
      old_revision_id: "b".repeat(21),
      old_title: null,
      old_type: null,
      old_source: null,
      new_id: null,
      new_revision_id: null,
      new_title: null,
      new_source: null,
      reason: "r",
      peer_name: null,
      superseded_at: supersededAt,
      operation_id: "op",
      h_metadata: null,
    });
    expect(encodeSupersedeLogRow(row(VALID_MICROS)).superseded_at).toBe(EXPECTED_ISO);
    throwsIntegrityFailure(() => encodeSupersedeLogRow(row(MS_MISTAKEN_FOR_US)), PublicationError);
  });
});

describe("storage.ts decodeArrowRows: raw-values-unavailable fallback fails closed (#105)", () => {
  /** A minimal fake matching exactly the duck-typed shape `decodeArrowRows`
   *  reads -- no real LanceDB/Arrow table needed to exercise the branch where
   *  the raw `BigInt64Array` behind the column is unavailable. */
  const fakeTimestampUsColumn = (getValue: () => unknown) => ({
    batches: [
      {
        numRows: 1,
        schema: { fields: [{ name: "created_at", nullable: false, type: { typeId: Type.Timestamp, unit: 2, timezone: null } }] },
        getChildAt: () => ({
          isValid: () => true,
          get: getValue,
          // No `values`: the raw BigInt64Array behind this vector is
          // unavailable, exactly the condition the old fallback covered.
          data: [{}],
        }),
      },
    ],
  });

  test("does not mislabel a lossy millisecond read as raw microseconds", () => {
    // Before the fix: BigInt(Number(1789982519383)) = 1789982519383n,
    // silently 1000x too small when read back as microseconds.
    expect(() => decodeArrowRows(fakeTimestampUsColumn(() => MS_MISTAKEN_FOR_US) as never)).toThrow();
  });

  test("still fails closed (not merely 'no crash') when the accessor returns a bigint too", () => {
    // Even a bigint from `.get()` is not RAW: only `data[].values` is proven
    // exact. This must not become a second silent success path.
    expect(() => decodeArrowRows(fakeTimestampUsColumn(() => VALID_MICROS) as never)).toThrow();
  });
});
