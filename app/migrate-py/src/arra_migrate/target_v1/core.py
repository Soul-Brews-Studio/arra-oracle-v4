"""CORE (5): the Honcho-shaped entities, declared again for the target.

Retained columns keep the active registry's physical types exactly. Additions
are the [P] source-identity columns from DESIGN.md §5 and #23 revision 2; every
addition is nullable except ``ingested_at`` (see Message).
"""

from ._base import LanceModel, Optional, datetime

WORKSPACES = "workspaces"
PEERS = "peers"
SESSIONS = "sessions"
SESSION_PEERS = "session_peers"
MESSAGES = "messages"


class Workspace(LanceModel):
    id: str
    name: str
    created_at: datetime
    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None
    configuration: Optional[str] = None
    mission: Optional[str] = None


class Peer(LanceModel):
    id: str
    name: str
    workspace_name: str
    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None
    configuration: Optional[str] = None
    created_at: datetime


class Session(LanceModel):
    id: str
    name: str
    workspace_name: str
    is_active: bool = True
    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None
    configuration: Optional[str] = None
    created_at: datetime


class SessionPeer(LanceModel):
    workspace_name: str
    session_name: str
    peer_name: str
    configuration: Optional[str] = None
    internal_metadata: Optional[str] = None
    joined_at: datetime
    left_at: Optional[datetime] = None


class Message(LanceModel):
    id: int                                   # legacy integer order, preserved
    public_id: str                            # nanoid21, external handle
    workspace_name: str
    session_name: str
    peer_name: str
    content: str
    token_count: int = 0
    seq_in_session: int
    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None
    created_at: datetime
    role: Optional[str] = None
    in_reply_to: Optional[str] = None
    read: Optional[bool] = None
    read_at: Optional[datetime] = None

    # [P] source identity. The triple (namespace, message_id, payload_digest)
    # is all-or-none -- a SERVICE rule, not a physical one; each column is
    # nullable so a locally authored message carries none of them.
    source_namespace: Optional[str] = None
    source_message_id: Optional[str] = None
    source_payload_digest: Optional[str] = None   # lowercase sha256 hex
    source_created_at: Optional[datetime] = None  # the source's own time

    # NOT NULL on purpose: server ingestion time is distinct from source time
    # and from legacy created_at. Migration must set it explicitly; a first-row
    # default would hide that decision.
    ingested_at: datetime
