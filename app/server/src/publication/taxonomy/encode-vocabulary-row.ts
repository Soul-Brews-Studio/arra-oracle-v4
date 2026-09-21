import { CARDINALITIES, HIERARCHIES, TERM_POLICIES, VOCABULARY_KINDS } from "./constants";
import { storedBoolean } from "./stored-boolean";
import { storedEnum } from "./stored-enum";
import { storedNullableText } from "./stored-nullable-text";
import { storedText } from "./stored-text";
import { storedTimestamp } from "./stored-timestamp";

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
