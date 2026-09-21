import { failPublication } from "./errors";
import { type DatasetAdapter } from "./service.types";

export async function requireExactlyOne(
  adapter: DatasetAdapter,
  table: string,
  predicate: string,
  path: string,
): Promise<Record<string, unknown>> {
  const rows = await adapter.query(table, predicate);
  if (rows.length === 0) failPublication("invalid_reference", path);
  if (rows.length > 1) failPublication("integrity_failure", path);
  return rows[0]!;
}
