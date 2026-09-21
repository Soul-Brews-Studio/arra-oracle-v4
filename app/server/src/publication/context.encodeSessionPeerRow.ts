import { ordered } from "./context.ordered";
import { storedName } from "./context.storedName";
import { storedNullableText } from "./context.storedNullableText";
import { storedNullableTimestamp } from "./context.storedNullableTimestamp";
import { storedTimestamp } from "./context.storedTimestamp";

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
