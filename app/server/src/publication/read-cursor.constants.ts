// Shared constants for the read-cursor split (Nat style: one exported
// function per file). Not functions, so this file is not itself subject to
// the ratchet -- plain values only, mirroring association.constants.ts and
// mcp/connections.state.ts's "single owner module for shared identity"
// discipline.

/** Request-parse bounds, shared by read-cursor.parseGetReadCursor.ts and
 *  read-cursor.parseAdvanceReadCursor.ts via read-cursor.parseRequest.ts. */
export const MAX_REQUEST_BYTES = 1048576;
export const MAX_REQUEST_DEPTH = 64;

/** Name-grammar and stored-name byte bound, shared by read-cursor.name.ts and
 *  read-cursor.storedName.ts. */
export const MAX_NAME_BYTES = 256;

/** The exact physical field order of a stored cursor row. */
export const READ_CURSOR_FIELDS = [
  "workspace_name",
  "peer_name",
  "session_name",
  "last_read_message_id",
  "last_read_at",
] as const;

/** The seven physical workspace columns, in their stored order. */
export const WORKSPACE_FIELDS = [
  "id",
  "name",
  "created_at",
  "h_metadata",
  "internal_metadata",
  "configuration",
  "mission",
] as const;
