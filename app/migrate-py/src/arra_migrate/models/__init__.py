"""One model, one file. The registry is the only place that knows all of them.

To add a table: write `models/<thing>.py` with a `TABLE` name and a `LanceModel`
subclass, then add one line below. Nothing else changes.

Order matters: FK targets come before their dependents, so creating in registry
order never references a table that does not exist yet. `workspaces` is first
because every other table carries `workspace_name`.

Source of truth is SPEC.md §3, §4, §6, §7, §12 and §14 -- read together only in
discussion #14, which is where this column layout comes from.

NOT HERE, and deliberately so:

  tokens          named in §7.1 PROSE ONLY (`token_hash`, never `token`); no
                  column block exists anywhere.
  oauth_clients   referenced in §7.2, defined nowhere. §7.2's whole argument for
                  why `connections` must exist is a three-way comparison against
                  this and mcp_calls -- one leg of it has no schema.
  delivery_refs   §12.5, in the model since v1, marked UNIMPLEMENTED.

The first two are the AUTH tables. Writing models for them would mean inventing
a schema the spec never agreed, so they stay absent until specced -- their
absence here IS the open issue, visible rather than papered over.
"""

from .connection import TABLE as CONNECTIONS, Connection
from .mcp_call import TABLE as MCP_CALLS, McpCall
from .memory import TABLE as MEMORIES, Memory
from .memory_term import TABLE as MEMORY_TERMS, MemoryTerm
from .message import TABLE as MESSAGES, Message
from .peer import TABLE as PEERS, Peer
from .read_cursor import TABLE as READ_CURSORS, ReadCursor
from .session import TABLE as SESSIONS, Session
from .session_peer import TABLE as SESSION_PEERS, SessionPeer
from .supersede_log import TABLE as SUPERSEDE_LOG, SupersedeLog
from .term import TABLE as TERMS, Term
from .trace import TABLE as TRACES, Trace
from .trace_hit import TABLE as TRACE_HITS, TraceHit
from .vocabulary import TABLE as VOCABULARIES, Vocabulary
from .workspace import TABLE as WORKSPACES, Workspace

# tier 1 -- Honcho's five, byte-compatible, additions nullable only (§15)
TIER_1 = {
    WORKSPACES: Workspace,
    PEERS: Peer,
    SESSIONS: Session,
    SESSION_PEERS: SessionPeer,
    MESSAGES: Message,
}

# tier 2 -- the memory layer, from arra-oracle-v3 (§3.4)
TIER_2 = {
    MEMORIES: Memory,
    VOCABULARIES: Vocabulary,
    TERMS: Term,
    MEMORY_TERMS: MemoryTerm,
    SUPERSEDE_LOG: SupersedeLog,
}

# tier 3 -- activity (§14, §6, §7) + messaging (§12)
TIER_3 = {
    TRACES: Trace,
    TRACE_HITS: TraceHit,
    MCP_CALLS: McpCall,
    CONNECTIONS: Connection,
    READ_CURSORS: ReadCursor,
}

TABLES = {**TIER_1, **TIER_2, **TIER_3}

__all__ = ["TABLES", "TIER_1", "TIER_2", "TIER_3"]
