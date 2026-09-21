import { failPublication } from "./errors";
import { INT64_CEILING } from "./service.constants";
import { type DatasetAdapter } from "./service.types";

/**
 * The greatest stored value of an Int64 key, or null when the scope is empty.
 *
 * Ordered projection, never `limit` alone: an unordered limit returns an
 * ARBITRARY row and can never yield a maximum. The selected extremum is
 * validated and then required unique on its own key, because an extremum read
 * says nothing about duplicates elsewhere -- this is deliberately NOT a
 * whole-corpus integrity audit.
 */
export async function selectedMaximum(
  adapter: DatasetAdapter,
  table: string,
  column: string,
  predicate: string,
): Promise<bigint | null> {
  const top = await adapter.orderedProjection(
    table,
    predicate,
    [column],
    { column, ascending: false },
    1,
  );
  if (top.length === 0) return null;
  const raw = top[0]![column];
  if (typeof raw !== "bigint") failPublication("integrity_failure", "");
  const value = raw;
  if (value < -(2n ** 63n) || value > INT64_CEILING) failPublication("integrity_failure", "");
  // Equality query bounded at 2 rows: enough to discriminate a duplicate key
  // without pretending to have audited the rest of the table.
  const sameKey = await adapter.query(table, `${predicate} AND ${column} = ${value.toString(10)}`, 2);
  if (sameKey.length !== 1) failPublication("integrity_failure", "");
  return value;
}
