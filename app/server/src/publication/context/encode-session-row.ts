import { ordered } from "./ordered";
import { storedBoolean } from "./stored-boolean";
import { storedId } from "./stored-id";
import { storedName } from "./stored-name";
import { storedNullableText } from "./stored-nullable-text";
import { storedTimestamp } from "./stored-timestamp";

export const SESSION_FIELDS = [
  "id", "name", "workspace_name", "is_active", "h_metadata", "internal_metadata", "configuration", "created_at",
] as const;

export function encodeSessionRow(row: Record<string, unknown>): Record<string, unknown> {
  return ordered({
    id: storedId(row.id),
    name: storedName(row.name),
    workspace_name: storedName(row.workspace_name),
    is_active: storedBoolean(row.is_active),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    configuration: storedNullableText(row.configuration),
    created_at: storedTimestamp(row.created_at),
  }, SESSION_FIELDS);
}
