import { ordered } from "./context.ordered";
import { storedInt64 } from "./context.storedInt64";
import { storedName } from "./context.storedName";
import { storedNullableText } from "./context.storedNullableText";
import { storedText } from "./context.storedText";
import { storedTimestamp } from "./context.storedTimestamp";

export const CONNECTION_FIELDS = [
  "id", "workspace_name", "method", "principal", "label", "user_agent", "remote_ip",
  "first_seen", "last_seen", "requests", "tool_calls", "last_tool",
] as const;

export function encodeConnectionRow(row: Record<string, unknown>): Record<string, unknown> {
  return ordered({
    // Free-form utf8 primary key, not the nanoid21 grammar -- see the same
    // note in `context.encodeMcpCallRow.ts`.
    id: storedText(row.id),
    workspace_name: storedName(row.workspace_name),
    method: storedText(row.method),
    principal: storedText(row.principal),
    label: storedText(row.label),
    user_agent: storedNullableText(row.user_agent),
    remote_ip: storedNullableText(row.remote_ip),
    // `connections.first_seen` / `last_seen` are `timestamp[us]`, unlike
    // `mcp_calls.created_at` -- see `context.storedMillisTimestamp.ts`'s
    // header for why the two tables need different converters.
    first_seen: storedTimestamp(row.first_seen),
    last_seen: storedTimestamp(row.last_seen),
    requests: storedInt64(row.requests, { min: 0n }),
    tool_calls: storedInt64(row.tool_calls, { min: 0n }),
    last_tool: row.last_tool === null || row.last_tool === undefined ? null : storedText(row.last_tool),
  }, CONNECTION_FIELDS);
}
