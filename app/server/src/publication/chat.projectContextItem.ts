// Split from chat.ts (style-split4b, 2026-09-28).
import { failPublication } from "./errors";
import type { ChatContextItem } from "./chat.state";

/**
 * Project one already-VALIDATED message row (`context.ts`'s own
 * `encodeMessageRow` output) to the reduced shape a chat prompt needs.
 *
 * Deliberately re-checks type, not shape: `encodeMessageRow` already proved
 * the row is a real message; this only proves the SUBSET this module reads
 * is still what it expects, the same discipline `read-cursor.ts`'s
 * `storedText` applies to a value it did not itself decode from bytes.
 */
export function projectContextItem(encodedMessage: Record<string, unknown>): ChatContextItem {
  const { public_id, session_name, peer_name, role, content, seq_in_session, created_at } = encodedMessage;
  if (typeof public_id !== "string") failPublication("integrity_failure", "");
  if (typeof session_name !== "string") failPublication("integrity_failure", "");
  if (typeof peer_name !== "string") failPublication("integrity_failure", "");
  if (typeof content !== "string") failPublication("integrity_failure", "");
  if (typeof seq_in_session !== "string") failPublication("integrity_failure", "");
  if (typeof created_at !== "string") failPublication("integrity_failure", "");
  return { public_id, session_name, peer_name, role: role ?? null, content, seq_in_session, created_at };
}
