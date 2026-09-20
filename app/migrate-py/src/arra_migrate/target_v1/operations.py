"""OPERATIONS (3): audit and delivery. DESIGN.md §13."""

from ._base import LanceModel, Optional, datetime

MCP_CALLS = "mcp_calls"
CONNECTIONS = "connections"
READ_CURSORS = "read_cursors"


class McpCall(LanceModel):
    id: str
    workspace_name: str
    session_name: Optional[str] = None
    peer_name: Optional[str] = None           # registered peer ONLY; never a user-agent
    tool: str
    status: str                               # ok | error
    duration_ms: int = 0
    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None
    created_at: int                           # legacy epoch ms, kept
    connection_id: Optional[str] = None       # [P] transport identity lives here
    principal: Optional[str] = None           # [P] token id / client id, never the credential


class Connection(LanceModel):
    id: str
    workspace_name: str
    method: str
    principal: str
    label: str
    user_agent: Optional[str] = None
    remote_ip: Optional[str] = None
    first_seen: datetime
    last_seen: datetime
    requests: int = 0
    tool_calls: int = 0
    last_tool: Optional[str] = None


class ReadCursor(LanceModel):
    workspace_name: str                       # [P] corrected scope; key (W, peer_name, session_name)
    peer_name: str
    session_name: str
    last_read_message_id: Optional[str] = None
    last_read_at: datetime
