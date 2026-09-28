import type { Table } from "@lancedb/lancedb";
import { decodeArrowRows } from "./storage.decodeArrowRows";

/**
 * Unchanged behaviour: where, optional limit, then decode.
 *
 * The decoding half now lives in `decodeArrowRows`; nothing else about this
 * function moved. It still has NO ordering, so a bare `limit` here still
 * returns arbitrary rows -- callers that need an extremum must order.
 */
export async function rawRows(table: Table, predicate: string, limit?: number): Promise<Record<string, unknown>[]> {
  let q = table.query().where(predicate);
  if (limit !== undefined) q = q.limit(limit);
  return decodeArrowRows(await q.toArrow());
}
