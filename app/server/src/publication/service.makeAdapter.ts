import { failPublication } from "./errors";
import { EMBEDDING_DIMENSION } from "./search-chunk";
import { type Connection, type Table, TARGET_TABLES, decodeArrowRows, quote, rawRows } from "./storage";
import { Field as ArrowField, FixedSizeList, Float32, List as ArrowList, Table as ArrowTable, Utf8, Vector as ArrowVector, makeData, tableFromArrays, vectorFromArray } from "apache-arrow";
import { type DatasetAdapter } from "./service.types";

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
        // `embedding` is `fixed_size_list<float32?>[384]`, always null on
        // this write path. A wholly-null column infers as a bare Float64
        // scalar -- true of ANY wholly-null column here, not just this one.
        // For a plain scalar physical column (`utf8`, `timestamp[us]`, an
        // int64) LanceDB casts that inferred Float64 down without complaint;
        // `last_attempt_at`, `embedded_at` and `error_code` all take that
        // cast on every row of this write path and are NOT special-cased
        // below. It is specifically `fixed_size_list` that LanceDB's native
        // reader refuses a Float64 against (MEASURED error below), because a
        // fixed-size list's physical layout has no scalar-to-list cast to
        // fall back on. That is the ONLY reason `embedding` -- and not the
        // other three all-null columns -- needs the hand-built vector here.
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
            // real (unread) zero-filled float buffer of the right size, with
            // every row's validity bit left at 0 (null).
            if (!values.every((value) => value === null || value === undefined)) {
              // This write path never populates embedding; a populated value
              // reaching here would need real float validation this branch
              // deliberately does not implement.
              failPublication("integrity_failure", "");
            }
            const rowCount = values.length;
            const child = makeData({
              type: new Float32(),
              data: new Float32Array(rowCount * EMBEDDING_DIMENSION),
            });
            const listData = makeData({
              type: new FixedSizeList(EMBEDDING_DIMENSION, new ArrowField("item", new Float32(), true)),
              length: rowCount,
              nullCount: rowCount,
              // All-zero bitmap: every bit unset means every row is null.
              nullBitmap: new Uint8Array(Math.ceil(rowCount / 8)),
              child,
            });
            vecs[key] = new ArrowVector([listData]);
          } else {
            vecs[key] = vectorFromArray(values as never);
          }
        }
        await tbl.add(new ArrowTable(vecs as never) as never);
        return tbl.version();
      }
      await tbl.add(tableFromArrays(columns as never) as never);
      return tbl.version();
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
