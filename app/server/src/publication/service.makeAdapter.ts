import { MatchQuery } from "@lancedb/lancedb";
import { ensureFtsIndexOn, ftsIndexStatus, refreshStaleFtsIndexOn } from "../fts/fts";
import { failPublication } from "./errors";
import { EMBEDDING_DIMENSION } from "./search-chunk";
import { SEARCH_CHUNKS, SEARCH_HIT_COLUMNS } from "./service.constants";
import { type Connection, type Table, TARGET_TABLES, decodeArrowRows, quote, rawRows } from "./storage";
import { Field as ArrowField, FixedSizeList, Float32, List as ArrowList, Table as ArrowTable, TimestampMicrosecond, Utf8, Vector as ArrowVector, makeData, tableFromArrays, vectorFromArray } from "apache-arrow";
import { type DatasetAdapter } from "./service.types";

/**
 * Explicit type for every `search_chunks_v1` `utf8` SCALAR column. Plain
 * inference dictionary-encodes a string array (see the `term_ids` comment
 * below for why a dictionary compares unequal to itself), which `append`'s
 * `.add()` tolerates -- MEASURED, it casts the mismatched-but-compatible
 * column down without complaint, which is why this table's tests already
 * passed before #90 despite every scalar column here going through bare
 * inference -- but `updateSearchChunkEmbedding`'s `mergeInsert` does NOT get
 * that same leniency: a dictionary-encoded `id` against the table's
 * plain-utf8 schema is refused outright ("Append with different schema",
 * one line per mismatched column). `chunk_index`/`attempts` (int64) and
 * `last_attempt_at`/`embedded_at` (timestamp[us]) are not listed here --
 * they need HAND-BUILT vectors, not an explicit type handed to
 * `vectorFromArray`; see `timestampVector` below for why.
 */
const SEARCH_CHUNK_UTF8_COLUMNS: ReadonlySet<string> = new Set([
  "id", "workspace_name", "node_id", "revision_id", "text", "content_hash",
  "chunker_version", "embedding_profile", "type_term_id", "observer_peer_name",
  "subject_peer_name", "session_name", "status", "error_code",
]);

const TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set(["last_attempt_at", "embedded_at"]);

/**
 * `timestamp[us]` column, built BY HAND rather than through
 * `vectorFromArray(values, new TimestampMicrosecond())`.
 *
 * MEASURED: that setter -- `apache-arrow`'s own
 * `setTimestampMicrosecond(data, index, value) => data.values[index] =
 * BigInt(value * 1000)` -- multiplies the incoming value by `1000` assuming
 * it is a plain JS number of MILLISECONDS, the `Date.valueOf()` convention.
 * This kernel's raw stored value is already MICROSECONDS, kept as a BigInt
 * end to end (`writableTimestamp`'s own doc: a JS Number here silently
 * corrupts at the far Gregorian boundary). Handing that bigint to a setter
 * that does `bigint * 1000` (a plain number) throws "Invalid mix of BigInt
 * and other type in multiplication" outright -- there is no scaling
 * convention here that both accepts a raw microsecond bigint AND avoids
 * that crash, so the buffer is written directly instead, matching
 * `embedding`'s own hand-built construction one column up.
 */
function timestampVector(values: unknown[]): unknown {
  const rowCount = values.length;
  const data = new BigInt64Array(rowCount);
  const nullBitmap = new Uint8Array(Math.ceil(rowCount / 8));
  let nullCount = 0;
  values.forEach((value, index) => {
    if (value === null || value === undefined) {
      nullCount += 1;
      return; // bit stays 0: null.
    }
    if (typeof value !== "bigint") failPublication("integrity_failure", "");
    nullBitmap[index >> 3]! |= 1 << (index & 7);
    data[index] = value;
  });
  const listData = makeData({ type: new TimestampMicrosecond(), length: rowCount, nullCount, nullBitmap, data });
  return new ArrowVector([listData]);
}

/**
 * `search_chunks_v1`-specific Arrow column construction, shared by `append`
 * (many rows, `embedding` always null on that path) and
 * `updateSearchChunkEmbedding` (exactly one row, `embedding` always
 * populated on that path -- #90's embed-step write). Neither caller can
 * build this table with blind inference; see the two field-specific
 * comments below for why.
 */
function buildSearchChunkVectors(columns: Record<string, unknown[]>): Record<string, unknown> {
  // MEASURED: blind inference cannot handle this table's two nested/
  // typed columns.
  //
  // `term_ids` is a `list<utf8?>`. Inferring a nested string array
  // dictionary-encodes it, and the inferrer's own self-check
  // recursively infers the SAME array a second time to compare types --
  // two independently-constructed Dictionary instances compare UNEQUAL
  // to each other even though they are structurally identical, so the
  // check fails and inference falls through every case to a throw.
  //
  // `embedding` is `fixed_size_list<float32?>[384]`. A wholly-null column
  // infers as a bare Float64 scalar -- true of ANY wholly-null column here,
  // not just this one. For a plain scalar physical column (`utf8`,
  // `timestamp[us]`, an int64) LanceDB casts that inferred Float64 down
  // without complaint; `last_attempt_at`, `embedded_at` and `error_code`
  // all take that cast on every row of the all-null write path and are NOT
  // special-cased below. It is specifically `fixed_size_list` that
  // LanceDB's native reader refuses a Float64 against (MEASURED error
  // below), because a fixed-size list's physical layout has no scalar-to-
  // list cast to fall back on. That is the ONLY reason `embedding` -- and
  // not the other three all-null columns -- needs the hand-built vector
  // here, and it is exactly as true for a MIX of null and populated rows
  // as it is for an all-null column: there is still no scalar-to-list cast
  // LanceDB can fall back on for the null rows in that mix.
  //
  // LanceDB's own returned `tbl.schema()` field types are NOT plain
  // instances of this package's DataType classes (measured: passing
  // them into `vectorFromArray` here throws "Unrecognized type 'NONE'"
  // from this package's own visitor dispatch), so the fix builds the
  // two types explicitly from this package's constructors instead of
  // borrowing LanceDB's -- every other column here still goes through
  // ordinary inference, unchanged.
  const vecs: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(columns)) {
    if (key === "term_ids") {
      vecs[key] = vectorFromArray(
        values as never,
        new ArrowList(new ArrowField("item", new Utf8(), true)) as never,
      );
    } else if (key === "embedding") {
      // `vectorFromArray` builds a ZERO-length child float buffer for an
      // all-null column (MEASURED: LanceDB's native reader then rejects
      // it -- "Values length 0 is less than the length (N) multiplied
      // by the value size (384)" -- because a FixedSizeList's physical
      // layout always reserves the full N*384 slots regardless of which
      // ones the validity bitmap marks null). Built by hand instead: a
      // real zero-filled float buffer of the right size, with each row's
      // validity bit and slice set from that row's own value -- 0 and an
      // unread slice for `null`, 1 and the row's own 384 floats
      // otherwise. #90 gave this table a populated-embedding write path,
      // so this can no longer assume every row is null the way the
      // all-null-only version of this branch could.
      const rowCount = values.length;
      const flat = new Float32Array(rowCount * EMBEDDING_DIMENSION);
      const nullBitmap = new Uint8Array(Math.ceil(rowCount / 8));
      let nullCount = 0;
      values.forEach((value, index) => {
        if (value === null || value === undefined) {
          nullCount += 1;
          return; // bit stays 0 in the all-zero-initialized bitmap: null.
        }
        if (
          !Array.isArray(value) ||
          value.length !== EMBEDDING_DIMENSION ||
          !value.every((item) => typeof item === "number" && Number.isFinite(item))
        ) {
          // This builder is the last line of defense before the SDK, not
          // the first: `storedEmbedding`/`embeddingVector` already refuse
          // a malformed value at their own boundaries. A malformed value
          // reaching HERE is this kernel's own construction being wrong,
          // not a caller mistake -- still refused, never silently coerced.
          failPublication("integrity_failure", "");
        }
        nullBitmap[index >> 3]! |= 1 << (index & 7);
        flat.set(value as number[], index * EMBEDDING_DIMENSION);
      });
      const child = makeData({ type: new Float32(), data: flat });
      const listData = makeData({
        type: new FixedSizeList(EMBEDDING_DIMENSION, new ArrowField("item", new Float32(), true)),
        length: rowCount,
        nullCount,
        nullBitmap,
        child,
      });
      vecs[key] = new ArrowVector([listData]);
    } else if (TIMESTAMP_COLUMNS.has(key)) {
      vecs[key] = timestampVector(values);
    } else if (SEARCH_CHUNK_UTF8_COLUMNS.has(key)) {
      vecs[key] = vectorFromArray(values as never, new Utf8() as never);
    } else {
      vecs[key] = vectorFromArray(values as never);
    }
  }
  return vecs;
}

export function makeAdapter(connection: Connection, onRelease: () => void): DatasetAdapter {
  const handles = new Map<string, Table>();
  let released = false;

  const handle = async (table: string): Promise<Table> => {
    // A released adapter stops working: closing is a gate, not a hint.
    if (released) failPublication("recovery_required");
    if (!TARGET_TABLES.includes(table)) failPublication("integrity_failure");
    let existing = handles.get(table);
    if (existing === undefined) {
      existing = await connection.openTable(table);
      handles.set(table, existing);
    }
    return existing;
  };

  return {
    async query(table, predicate, limit) {
      const tbl = await handle(table);
      await tbl.checkoutLatest();
      return rawRows(tbl, predicate, limit);
    },
    async orderedProjection(table, predicate, columns, ordering, limit) {
      const tbl = await handle(table);
      await tbl.checkoutLatest();
      const arrow = await tbl
        .query()
        .where(predicate)
        .select(columns)
        .orderBy([{ columnName: ordering.column, ascending: ordering.ascending }])
        .limit(limit)
        .toArrow();
      // Same decoder as rawRows, deliberately: a second decoding path is how a
      // lossy Number fallback returns on one side only.
      return decodeArrowRows(arrow);
    },
    async count(table, predicate) {
      const tbl = await handle(table);
      await tbl.checkoutLatest();
      // Guard the count at the ADAPTER, not at each call site. Two branches
      // added this method independently: one validated here, one validated
      // before stringifying in its own service. Keeping the adapter's version
      // protects every future caller instead of only the two that exist now.
      // A count that comes back non-integer or negative is the storage layer
      // lying, and it would otherwise be stringified into a canonical decimal
      // on the wire -- a lie with a trustworthy format.
      const total = await tbl.countRows(predicate);
      if (!Number.isSafeInteger(total) || total < 0) failPublication("integrity_failure");
      return total;
    },
    async deleteDerivedScope(table, workspace, revisionId) {
      // Restricted by construction: only these two tables, and the predicate
      // is built here from the reviewed literal escaper.
      if (table !== "node_revision_terms" && table !== "revision_links") {
        failPublication("integrity_failure");
      }
      // No checkoutLatest here: the ONLY caller preflights this exact scope
      // with a refresh immediately before, inside the same serialized turn.
      const tbl = await handle(table);
      const result = (await tbl.delete(
        `workspace_name = ${quote(workspace)} AND revision_id = ${quote(revisionId)}`,
      )) as unknown as { numDeletedRows?: number };
      const deleted = result?.numDeletedRows;
      // Measured: a ZERO-match delete still advances the version, so the count
      // -- not the version -- is what distinguishes a real deletion.
      if (typeof deleted !== "number" || !Number.isSafeInteger(deleted) || deleted < 0) {
        failPublication("integrity_failure");
      }
      return { numDeletedRows: deleted, version: await tbl.version() };
    },
    async refresh(table) {
      await (await handle(table)).checkoutLatest();
    },
    async version(table) {
      return (await handle(table)).version();
    },
    async append(table, rows) {
      const tbl = await handle(table);
      // Build an Arrow table rather than handing over plain objects.
      //
      // MEASURED on the installed stack: a plain object with a BigInt
      // timestamp is rejected outright, and a JS NUMBER is far worse -- it is
      // accepted and silently corrupts, with 253402300799999000 reading back
      // as -4852116231934706. Arrow construction from BigInts round-trips
      // exactly, including sub-millisecond and the far Gregorian boundary.
      const columns: Record<string, unknown[]> = {};
      for (const row of rows) {
        for (const key of Object.keys(row)) (columns[key] ??= []).push(row[key]);
      }
      if (table === "search_chunks_v1") {
        const vecs = buildSearchChunkVectors(columns);
        await tbl.add(new ArrowTable(vecs as never) as never);
        return tbl.version();
      }
      await tbl.add(tableFromArrays(columns as never) as never);
      return tbl.version();
    },
    async updateSearchChunkEmbedding(row) {
      const tbl = await handle("search_chunks_v1");
      // No `checkoutLatest` here: mirrors `deleteDerivedScope`'s own
      // convention -- the only caller (`writeChunkEmbedding`) preflights
      // this exact row with its own `refresh` immediately before, inside
      // the same serialized turn.
      const columns: Record<string, unknown[]> = {};
      for (const key of Object.keys(row)) columns[key] = [row[key]];
      const vecs = buildSearchChunkVectors(columns);
      // `whenMatchedUpdateAll` with no `whenNotMatchedInsertAll`: a row
      // whose `id` does not already exist in the target is left untouched,
      // never created. This can only UPDATE a chunk `append` already wrote.
      await tbl.mergeInsert(["id"]).whenMatchedUpdateAll().execute(new ArrowTable(vecs as never) as never);
      return tbl.version();
    },
    // ── #30 retrieval over search_chunks_v1 (R7 #30 part + R14) ───────────
    // Hardcoded to one table and one column each, like
    // `updateSearchChunkEmbedding`: no caller names a table or a column here.
    async ensureSearchChunkTextIndex() {
      // Writer maintenance: see the type's doc. `checkoutLatest` so the index
      // decision is made against the latest version, including the rows the
      // turn before this one wrote.
      const tbl = await handle(SEARCH_CHUNKS);
      await tbl.checkoutLatest();
      const labels = await ensureFtsIndexOn(tbl, "text", false);
      return (await refreshStaleFtsIndexOn(tbl, "text")) ? (await tbl.listIndices()).map((i) => `${i.name}:${i.indexType}`) : labels;
    },
    async searchChunkTextIndexStatus() {
      const tbl = await handle(SEARCH_CHUNKS);
      await tbl.checkoutLatest();
      return ftsIndexStatus(await tbl.listIndices(), "text");
    },
    async fullTextSearchChunks(query, predicate, limit) {
      const tbl = await handle(SEARCH_CHUNKS);
      await tbl.checkoutLatest();
      // A `MatchQuery`, never a bare string: LanceDB parses a bare string, and
      // a quoted one becomes a phrase query this position-less index cannot
      // serve (the same reason as `fts.substringSearch`).
      const arrow = await tbl
        .query()
        .fullTextSearch(new MatchQuery(query, "text"))
        .where(predicate)
        .select([...SEARCH_HIT_COLUMNS, "_score"])
        .limit(limit)
        .toArrow();
      return decodeArrowRows(arrow);
    },
    async vectorSearchChunks(vector, predicate, limit) {
      const tbl = await handle(SEARCH_CHUNKS);
      await tbl.checkoutLatest();
      const arrow = await tbl
        .vectorSearch(vector)
        .column("embedding")
        .distanceType("l2")
        .where(predicate)
        .select([...SEARCH_HIT_COLUMNS, "_distance"])
        .limit(limit)
        .toArrow();
      return decodeArrowRows(arrow);
    },
    async updateWhere(table, predicate, assignments) {
      const tbl = await handle(table);
      await tbl.checkoutLatest();
      const result = (await tbl.update(assignments, { where: predicate })) as unknown as {
        rowsUpdated?: number;
      };
      return {
        rowsUpdated: typeof result?.rowsUpdated === "number" ? result.rowsUpdated : 0,
        version: await tbl.version(),
      };
    },
    release() {
      released = true;
      handles.clear();
      onRelease();
    },
  };
}
