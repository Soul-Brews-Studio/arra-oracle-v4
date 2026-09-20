"""`session_peers` -- membership WITH history. tier 1 / models.py:569.

Principle 1 living inside a join table: leaving a session is a TIMESTAMP,
never a DELETE.
"""

from ._base import LanceModel, Optional, datetime

TABLE = "session_peers"


class SessionPeer(LanceModel):
    workspace_name: str
    session_name: str
    peer_name: str
    configuration: Optional[str] = None
    internal_metadata: Optional[str] = None
    joined_at: datetime
    left_at: Optional[datetime] = None        # <== leaving is a timestamp, not a DELETE
