"""`connections` -- a PROJECTION of the request stream, NOT a log. SPEC.md §7.2.

ONE ROW PER CALLER, not per request: a row per request would grow without bound
to answer a question about the present. Folded on write -- first_seen kept,
last_* replaced, counters added.

`principal` is a token id or oauth client_id. NEVER the credential itself.
"""

from ._base import LanceModel, Optional, datetime

TABLE = "connections"


class Connection(LanceModel):
    id: str                                   # '<method>:<principal>'
    workspace_name: str                       # v4 adds this; digger-node was single-corpus
    method: str                               # bearer | oauth | owner-session
    principal: str                            # <== NEVER the credential itself
    label: str                                # resolved at WRITE time, so a renamed client shows its current face
    user_agent: Optional[str] = None
    remote_ip: Optional[str] = None
    first_seen: datetime                      # } folded on write:
    last_seen: datetime                       # }   first_seen KEPT · last_* REPLACED
    requests: int = 0                         # }   counters ADDED
    tool_calls: int = 0
    last_tool: Optional[str] = None
