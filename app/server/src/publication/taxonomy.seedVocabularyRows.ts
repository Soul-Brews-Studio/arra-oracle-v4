import { MICROS_PER_MILLI, VOCABULARY_FIELDS } from "./taxonomy.constants";
import type { SeedRequest } from "./taxonomy.types";

/**
 * The literal bootstrap rows.
 *
 * `createdAtMs` comes from the trusted clock and is used ONLY for rows that
 * are actually missing; an existing row keeps its own validated allocation
 * time rather than being resampled.
 */
export function seedVocabularyRows(
  request: SeedRequest,
  createdAtMs: number,
): Array<Record<string, unknown>> {
  const micros = BigInt(createdAtMs) * MICROS_PER_MILLI;
  const common = {
    workspace_name: request.workspace_name,
    description: null,
    kind: "categories",
    term_policy: "sealed",
    cardinality: "one",
    hierarchy: "flat",
    h_metadata: null,
    internal_metadata: null,
    created_at: micros,
  };
  return [
    // type is required: an omitted type resolves to note.
    { id: request.type.vocabulary_id, name: "type", label: "Type", required: true, ...common },
    // memory_horizon is not: an omitted horizon stays unclassified.
    {
      id: request.memory_horizon.vocabulary_id,
      name: "memory_horizon",
      label: "Memory horizon",
      required: false,
      ...common,
    },
  ].map((row) => {
    const ordered: Record<string, unknown> = {};
    for (const field of VOCABULARY_FIELDS) ordered[field] = row[field as keyof typeof row];
    return ordered;
  });
}
