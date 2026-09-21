import { ordered } from "./ordered";
import { storedName } from "./stored-name";
import { storedNullableText } from "./stored-nullable-text";
import { storedNullableTimestamp } from "./stored-nullable-timestamp";
import { storedTimestamp } from "./stored-timestamp";

export const SESSION_PEER_FIELDS = [
  "workspace_name", "session_name", "peer_name", "configuration", "internal_metadata", "joined_at", "left_at",
] as const;

export function encodeSessionPeerRow(row: Record<string, unknown>): Record<string, unknown> {
  return ordered({
    workspace_name: storedName(row.workspace_name),
    session_name: storedName(row.session_name),
    peer_name: storedName(row.peer_name),
    configuration: storedNullableText(row.configuration),
    internal_metadata: storedNullableText(row.internal_metadata),
    joined_at: storedTimestamp(row.joined_at),
    left_at: storedNullableTimestamp(row.left_at),
  }, SESSION_PEER_FIELDS);
}
