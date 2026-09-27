// Split (Nat style, one exported function per file —
// docs/overnight/DECISIONS.md, slice style-server-split, 2026-09-28):
// scopeOf -> service.constants.scopeOf.ts, cursorKey ->
// service.constants.cursorKey.ts. Re-exported below so importers do not churn.
export { scopeOf } from "./service.constants.scopeOf";
export { cursorKey } from "./service.constants.cursorKey";

export const MAX_REQUEST_BYTES = 1048576;

export const MAX_REQUEST_DEPTH = 64;

/** nanoid21, matching the existing governed grammar. */
export const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

export const RESERVED_TYPE_VOCABULARY = "type";

export const MEMORY_HORIZON_VOCABULARY = "memory_horizon";

export const VOCABULARIES = "vocabularies";

export const TERMS = "terms";

export const WORKSPACES = "workspaces";

export const PEERS = "peers";

export const SESSIONS = "sessions";

export const SESSION_PEERS = "session_peers";

export const MESSAGES = "messages";

export const READ_CURSORS = "read_cursors";

export const SESSION_LINKS = "session_links";

export const NODES = "nodes";

export const NODE_REVISIONS = "node_revisions";

export const SUPERSEDE_LOG = "supersede_log";

export const TRACES = "traces";

export const TRACE_HITS = "trace_hits";

export const SEARCH_CHUNKS = "search_chunks_v1";

/** The columns a retrieval candidate is read with (#30): never `embedding`,
 *  which is 384 floats per row that no hit reports. */
export const SEARCH_HIT_COLUMNS: readonly string[] = Object.freeze(["id", "node_id", "revision_id", "chunk_index", "text"]);

export const MCP_CALLS = "mcp_calls";

export const CONNECTIONS = "connections";

export const INT64_CEILING = 2n ** 63n - 1n;

/** Bounded forward-walk cap for the replacement chain (#29). */
export const MAX_CHAIN_WALK = 1024;

export const TERMS_TABLE = "node_revision_terms";

export const LINKS_TABLE = "revision_links";
