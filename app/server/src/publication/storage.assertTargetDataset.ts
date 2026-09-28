import type { Connection } from "@lancedb/lancedb";
import { failPublication } from "./errors";
import { TARGET_SCHEMA, TARGET_TABLES } from "./storage.schema";
import { describeField } from "./storage.describeField";

/**
 * Verify all 19 tables AND their physical schemas against the golden.
 *
 * Name presence alone would accept a drifted dataset whose columns had
 * changed type or nullability underneath -- which is exactly the failure this
 * gate exists to catch. Nothing is written, no version is bumped and no row
 * is touched on rejection.
 */
export async function assertTargetDataset(connection: Connection): Promise<void> {
  // Ask for far more names than can exist: `tableNames` paginates, and a
  // silent truncation would read as "table absent".
  const present = new Set(await connection.tableNames({ limit: 1000 }));
  if (present.size >= 1000) failPublication("unsupported_dataset");

  for (const table of TARGET_TABLES) {
    if (!present.has(table)) failPublication("unsupported_dataset");
    const expected = TARGET_SCHEMA[table]!;
    let schema: { fields: { name: string; nullable: boolean; type: { toString(): string } }[] };
    try {
      schema = (await (await connection.openTable(table)).schema()) as never;
    } catch {
      return failPublication("unsupported_dataset");
    }
    if (schema.fields.length !== expected.length) failPublication("unsupported_dataset");
    for (let i = 0; i < expected.length; i++) {
      const [name, type, nullable] = expected[i]!;
      const actual = schema.fields[i]!;
      if (actual.name !== name) failPublication("unsupported_dataset");
      if (describeField(actual) !== type) failPublication("unsupported_dataset");
      if (actual.nullable !== nullable) failPublication("unsupported_dataset");
    }
  }
}
