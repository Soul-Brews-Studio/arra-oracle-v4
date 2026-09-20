"""`read_cursors` -- pull, not push. SPEC.md §12.4.

Deliberately PULL. Honest, needs no broker, and keeps working when every other
moving part is down. MQTT later becomes an ACCELERATOR on top -- never a
replacement, because a session offline during the publish must still find the
message.
"""

from ._base import LanceModel, Optional, datetime

TABLE = "read_cursors"


class ReadCursor(LanceModel):
    peer_name: str                            # } PK
    session_name: str                         # } the thread
    last_read_message_id: Optional[str] = None
    last_read_at: datetime
