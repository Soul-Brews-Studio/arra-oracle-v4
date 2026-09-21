import { ordered } from "./context.ordered";
import { storedInt64 } from "./context.storedInt64";
import { storedMillisTimestamp } from "./context.storedMillisTimestamp";
import { storedName } from "./context.storedName";
import { storedNullableText } from "./context.storedNullableText";
import { storedText } from "./context.storedText";

export const MCP_CALL_FIELDS = [
  "id", "workspace_name", "session_name", "peer_name", "tool", "status", "duration_ms",
  "h_metadata", "internal_metadata", "created_at", "connection_id", "principal",
] as const;

/**
 * This method is `audit:read`-gated end to end (see `service.listMcpCalls.ts`),
 * so `h_metadata` -- which carries `auth.credential_id` per
 * `authorization-integration-v1.md` -- is passed through UNCHANGED, exactly
 * like `context.encodeMessageRow.ts` treats its own `h_metadata`. Nothing
 * here re-shapes or strips it; the entitlement is enforced by which action
 * the caller was admitted for, not by field surgery in the encoder.
 */
export function encodeMcpCallRow(row: Record<string, unknown>): Record<string, unknown> {
  return ordered({
    // `mcp_calls.id` (`c_<base36ms>_<random6>`, from `mcp/calls.ts`) is a
    // free-form utf8 primary key, not the nanoid21 grammar `storedId`
    // enforces -- so this uses the plain nonempty-Unicode check instead.
    id: storedText(row.id),
    workspace_name: storedName(row.workspace_name),
    session_name: row.session_name === null || row.session_name === undefined ? null : storedName(row.session_name),
    peer_name: row.peer_name === null || row.peer_name === undefined ? null : storedName(row.peer_name),
    tool: storedText(row.tool),
    status: storedText(row.status),
    duration_ms: storedInt64(row.duration_ms),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    // Raw int64 MILLISECONDS -- see `context.storedMillisTimestamp.ts`.
    created_at: storedMillisTimestamp(row.created_at),
    connection_id: row.connection_id === null || row.connection_id === undefined ? null : storedText(row.connection_id),
    principal: row.principal === null || row.principal === undefined ? null : storedText(row.principal),
  }, MCP_CALL_FIELDS);
}
