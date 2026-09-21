import { HORIZON_TERMS, MICROS_PER_MILLI, TERM_FIELDS, TYPE_TERMS } from "./taxonomy.constants";
import type { SeedRequest } from "./taxonomy.types";

export function seedTermRows(
  request: SeedRequest,
  createdAtMs: number,
): Array<Record<string, unknown>> {
  const micros = BigInt(createdAtMs) * MICROS_PER_MILLI;
  const rows: Array<Record<string, unknown>> = [];
  const push = (id: string, name: string, vocabularyId: string) => {
    const row: Record<string, unknown> = {
      id,
      workspace_name: request.workspace_name,
      vocabulary_id: vocabularyId,
      name,
      description: null,
      parent_id: null,
      weight: 0,
      is_active: true,
      h_metadata: null,
      created_at: micros,
    };
    const ordered: Record<string, unknown> = {};
    for (const field of TERM_FIELDS) ordered[field] = row[field];
    rows.push(ordered);
  };
  // Literal staging order: type terms first, then horizon terms.
  for (const key of TYPE_TERMS) push(request.type.terms[key]!, key, request.type.vocabulary_id);
  for (const key of HORIZON_TERMS) {
    push(request.memory_horizon.terms[key]!, key, request.memory_horizon.vocabulary_id);
  }
  return rows;
}
