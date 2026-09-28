import { failPublication } from "./errors";
import { describeField } from "./storage.describeField";

/**
 * Read query results from RAW Arrow buffers.
 *
 * `toArray()` hands back row objects whose timestamp[us] values have already
 * been divided into lossy JS numbers and whose Int64s may have been coerced.
 * By the time we could inspect them the precision is gone, so this walks the
 * record batches and pulls each column's underlying values instead -- with
 * validity checked per row rather than assumed.
 *
 * Extracted from `rawRows` so an ordered/projected query can decode through
 * exactly the same path instead of growing a second, subtly different one --
 * a duplicate decoder is how a Number fallback creeps back in on one side only.
 *
 * Carries DATA, not authority: it takes an Arrow table a caller already holds
 * and returns plain records. It opens nothing, holds nothing and cannot reach
 * a connection, table handle or owner.
 */
export function decodeArrowRows(arrow: {
  batches: ReadonlyArray<{
    numRows: number;
    schema: { fields: ReadonlyArray<{ name: string }> };
    getChildAt(index: number): { isValid(row: number): boolean; get(row: number): unknown; data: ReadonlyArray<{ values?: unknown; offset?: number }> } | null;
  }>;
}): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];

  for (const batch of arrow.batches) {
    for (let row = 0; row < batch.numRows; row++) {
      const record: Record<string, unknown> = {};
      for (let col = 0; col < batch.schema.fields.length; col++) {
        const field = batch.schema.fields[col]!;
        const vector = batch.getChildAt(col);
        if (vector === null) {
          record[field.name] = null;
          continue;
        }
        if (!vector.isValid(row)) {
          record[field.name] = null;
          continue;
        }
        const typed = describeField(field as never);
        if (typed === "timestamp[us]") {
          // The RAW int64 microseconds, before any Date conversion.
          const data = vector.data[0];
          const values = data?.values as BigInt64Array | undefined;
          const offset = (data?.offset ?? 0) + row;
          if (values === undefined || offset >= values.length) {
            // No raw buffer to read (#105): `vector.get(row)` is the SAME
            // lossy row accessor `toArray()` uses, which returns MILLISECONDS
            // for a timestamp[us] cell (LANCEDB-FACTS.md §1). The old
            // fallback here was `BigInt(Number(vector.get(row)))`, which
            // relabels that millisecond value as microseconds and silently
            // understates the real instant 1000x instead of failing closed.
            // A dataset this decoder cannot read raw is one it must refuse,
            // not approximate.
            failPublication("integrity_failure");
          }
          record[field.name] = values[offset];
          continue;
        }
        const value = vector.get(row);
        record[field.name] = typed === "int64" && typeof value !== "bigint" ? BigInt(value as number) : value;
      }
      out.push(record);
    }
  }
  return out;
}
