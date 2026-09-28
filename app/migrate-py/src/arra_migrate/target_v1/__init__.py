"""The target-19 registry. arra-v4-target/1.

This package declares the 19 target tables and their physical Arrow shape.
Since R32 (Nat 2026-09-28, #135; docs/overnight/DECISIONS.md) it is the
DEFAULT registry: ``python -m arra_migrate`` creates exactly these tables.

  - ``arra_migrate.models.TABLES`` is the LEGACY 15-table set, created only by
    ``python -m arra_migrate --legacy-active15`` for the legacy routes.
  - Nothing in this package creates a table on import. The migrator
    (``__main__``) imports it; tests write only to temporary roots.
  - The target REPLACES ``memories`` / ``memory_terms`` with node revisions;
    it is 15 - 2 + 6 = 19, not 15 + 4.

Order below is the manifest order (contracts/target-19-manifest.json): a
stable PRESENTATION order, grouped by the design's sections. It carries no
claim about references or creation order, and it is not topologically sorted
-- `node_revision_terms` precedes the `terms` it points at, and
`revision_links` precedes several of its targets. Creation order is a
migration concern, and LanceDB has no foreign keys to order around.
"""

from .context import SESSION_LINKS, SessionLink
from .core import (
    MESSAGES,
    PEERS,
    SESSION_PEERS,
    SESSIONS,
    WORKSPACES,
    Message,
    Peer,
    Session,
    SessionPeer,
    Workspace,
)
from .investigation import TRACE_HITS, TRACES, Trace, TraceHit
from .knowledge import (
    NODE_REVISION_TERMS,
    NODE_REVISIONS,
    NODES,
    REVISION_LINKS,
    SUPERSEDE_LOG,
    Node,
    NodeRevision,
    NodeRevisionTerm,
    RevisionLink,
    SupersedeLog,
)
from .operations import (
    CONNECTIONS,
    MCP_CALLS,
    READ_CURSORS,
    Connection,
    McpCall,
    ReadCursor,
)
from .search import SEARCH_CHUNKS_V1, SearchChunkV1
from .taxonomy import TERMS, VOCABULARIES, Term, Vocabulary

TARGET_REGISTRY_VERSION = "arra-v4-target/1"

# The literal ordered tuple. Tests assert against THIS, not against a count.
TARGET_TABLE_NAMES = (
    WORKSPACES,
    PEERS,
    SESSIONS,
    SESSION_PEERS,
    MESSAGES,
    SESSION_LINKS,
    NODES,
    NODE_REVISIONS,
    NODE_REVISION_TERMS,
    REVISION_LINKS,
    SUPERSEDE_LOG,
    VOCABULARIES,
    TERMS,
    TRACES,
    TRACE_HITS,
    SEARCH_CHUNKS_V1,
    MCP_CALLS,
    CONNECTIONS,
    READ_CURSORS,
)

TARGET_TABLES = {
    WORKSPACES: Workspace,
    PEERS: Peer,
    SESSIONS: Session,
    SESSION_PEERS: SessionPeer,
    MESSAGES: Message,
    SESSION_LINKS: SessionLink,
    NODES: Node,
    NODE_REVISIONS: NodeRevision,
    NODE_REVISION_TERMS: NodeRevisionTerm,
    REVISION_LINKS: RevisionLink,
    SUPERSEDE_LOG: SupersedeLog,
    VOCABULARIES: Vocabulary,
    TERMS: Term,
    TRACES: Trace,
    TRACE_HITS: TraceHit,
    SEARCH_CHUNKS_V1: SearchChunkV1,
    MCP_CALLS: McpCall,
    CONNECTIONS: Connection,
    READ_CURSORS: ReadCursor,
}

# What the target removes from, and adds to, the active 15.
REPLACED_ACTIVE_TABLES = ("memories", "memory_terms")
ADDED_TARGET_TABLES = (
    SESSION_LINKS,
    NODES,
    NODE_REVISIONS,
    NODE_REVISION_TERMS,
    REVISION_LINKS,
    SEARCH_CHUNKS_V1,
)

__all__ = [
    "ADDED_TARGET_TABLES",
    "REPLACED_ACTIVE_TABLES",
    "TARGET_REGISTRY_VERSION",
    "TARGET_TABLES",
    "TARGET_TABLE_NAMES",
]
