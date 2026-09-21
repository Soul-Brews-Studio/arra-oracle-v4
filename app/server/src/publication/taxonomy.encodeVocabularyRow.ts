import { CARDINALITIES, HIERARCHIES, TERM_POLICIES, VOCABULARY_KINDS } from "./taxonomy.constants";
import { storedBoolean } from "./taxonomy.storedBoolean";
import { storedEnum } from "./taxonomy.storedEnum";
import { storedNullableText } from "./taxonomy.storedNullableText";
import { storedText } from "./taxonomy.storedText";
import { storedTimestamp } from "./taxonomy.storedTimestamp";

export function encodeVocabularyRow(row: Record<string, unknown>): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    id: storedText(row.id),
    name: storedText(row.name),
    workspace_name: storedText(row.workspace_name),
    label: storedText(row.label),
    description: storedNullableText(row.description),
    kind: storedEnum(row.kind, VOCABULARY_KINDS),
    term_policy: storedEnum(row.term_policy, TERM_POLICIES),
    cardinality: storedEnum(row.cardinality, CARDINALITIES),
    required: storedBoolean(row.required),
    hierarchy: storedEnum(row.hierarchy, HIERARCHIES),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    created_at: storedTimestamp(row.created_at),
  };
  return encoded;
}
