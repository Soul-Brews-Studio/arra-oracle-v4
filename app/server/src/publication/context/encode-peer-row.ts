import { ordered } from "./ordered";
import { storedId } from "./stored-id";
import { storedName } from "./stored-name";
import { storedNullableText } from "./stored-nullable-text";
import { storedTimestamp } from "./stored-timestamp";

/** Physical order, quoted from target_v1/core.py. Not invented here. */
export const PEER_FIELDS = [
  "id", "name", "workspace_name", "h_metadata", "internal_metadata", "configuration", "created_at",
] as const;

export function encodePeerRow(row: Record<string, unknown>): Record<string, unknown> {
  return ordered({
    id: storedId(row.id),
    name: storedName(row.name),
    workspace_name: storedName(row.workspace_name),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    configuration: storedNullableText(row.configuration),
    created_at: storedTimestamp(row.created_at),
  }, PEER_FIELDS);
}
