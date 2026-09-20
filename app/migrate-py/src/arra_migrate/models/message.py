"""`messages` -- tier 1, Honcho's, plus four nullable v4 columns. models.py:206.

TWO keys on purpose: `id` is internal order, `public_id` is the external handle.
ORDER IS A CONSTRAINT -- UNIQUE (workspace_name, session_name, seq_in_session).
Timestamps tie under fast writes; a uniqueness constraint cannot.
"""

from ._base import LanceModel, Optional, datetime

TABLE = "messages"


class Message(LanceModel):
    id: int                                   # autoincrement, internal order
    public_id: str                            # nanoid(21), external handle
    workspace_name: str
    session_name: str
    peer_name: str
    content: str                              # <= 65535
    token_count: int = 0
    seq_in_session: int
    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None
    created_at: datetime

    # +v4, all nullable so a bank still imports into stock Honcho (§15).
    # `role` is FREE TEXT, not an enum -- a new one is a string, not a migration.
    role: Optional[str] = None                # seen: question | answer | note
    in_reply_to: Optional[str] = None         # FK -> messages.public_id; replies nest, sessions do not
    read: Optional[bool] = None               # 8,597 vault files already carry these (§12.4)
    read_at: Optional[datetime] = None
