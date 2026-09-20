"""`sessions` -- tier 1, Honcho's. SPEC.md §3.2 / models.py:167.

FLAT. No parent_id, no channel/thread split, no nesting anywhere (§3.1.1).
`is_active` is a BIT, not a status enum -- two states need one bit.
"""

from ._base import LanceModel, Optional, datetime

TABLE = "sessions"


class Session(LanceModel):
    id: str
    name: str
    workspace_name: str                       # FK -> workspaces.name
    is_active: bool = True
    h_metadata: Optional[str] = None          # room · issue_url · issue_number · project
    internal_metadata: Optional[str] = None
    configuration: Optional[str] = None
    created_at: datetime
    # UNIQUE (name, workspace_name)
