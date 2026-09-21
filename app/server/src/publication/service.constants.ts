import { quote } from "./storage";
import { contextScope } from "./service.contextScope";

export const MAX_REQUEST_BYTES = 1048576;

export const MAX_REQUEST_DEPTH = 64;

/** nanoid21, matching the existing governed grammar. */
export const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

export const RESERVED_TYPE_VOCABULARY = "type";

export const MEMORY_HORIZON_VOCABULARY = "memory_horizon";

export const VOCABULARIES = "vocabularies";

export const TERMS = "terms";

export const scopeOf = (workspace: string) => `workspace_name = ${quote(workspace)}`;

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

export const MCP_CALLS = "mcp_calls";

export const CONNECTIONS = "connections";

export const INT64_CEILING = 2n ** 63n - 1n;

/** Bounded forward-walk cap for the replacement chain (#29). */
export const MAX_CHAIN_WALK = 1024;

export const cursorKey = (workspace: string, peer: string, session: string): string =>
  `${contextScope(workspace)} AND peer_name = ${quote(peer)} AND session_name = ${quote(session)}`;

export const TERMS_TABLE = "node_revision_terms";

export const LINKS_TABLE = "revision_links";
