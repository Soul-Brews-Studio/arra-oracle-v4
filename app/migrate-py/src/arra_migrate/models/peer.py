"""`peers` -- tier 1, Honcho's. SPEC.md §3.2 / models.py:130."""

from ._base import LanceModel, Optional, datetime

TABLE = "peers"


class Peer(LanceModel):
    id: str
    # The WHOLE federation tag, host included: 'm5:arra-oracle-v3'.
    name: str
    workspace_name: str                       # FK -> workspaces.name
    h_metadata: Optional[str] = None          # kind · display_name · repo_url · mcp_url · last_seen_at
    internal_metadata: Optional[str] = None
    configuration: Optional[str] = None
    created_at: datetime
    # UNIQUE (name, workspace_name)
