import { storedBoolean } from "./stored-boolean";
import { storedNullableText } from "./stored-nullable-text";
import { storedText } from "./stored-text";
import { storedTimestamp } from "./stored-timestamp";
import { storedWeight } from "./stored-weight";

export function encodeTermRow(row: Record<string, unknown>): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    id: storedText(row.id),
    workspace_name: storedText(row.workspace_name),
    vocabulary_id: storedText(row.vocabulary_id),
    name: storedText(row.name),
    description: storedNullableText(row.description),
    parent_id: row.parent_id === null || row.parent_id === undefined ? null : storedText(row.parent_id),
    weight: storedWeight(row.weight),
    is_active: storedBoolean(row.is_active),
    h_metadata: storedNullableText(row.h_metadata),
    created_at: storedTimestamp(row.created_at),
  };
  return encoded;
}
