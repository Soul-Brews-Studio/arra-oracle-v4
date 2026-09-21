import { ordered } from "./context.ordered";
import { storedBoolean } from "./context.storedBoolean";
import { storedId } from "./context.storedId";
import { storedName } from "./context.storedName";
import { storedNullableText } from "./context.storedNullableText";
import { storedTimestamp } from "./context.storedTimestamp";

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
