"""`vocabularies` -- the taxonomy root. SPEC.md §3.3.

`kind` (tags | categories) is the whole point of §3.3.1. `term_policy` decides
whether a MODEL may create terms here, or only a human.
"""

from ._base import LanceModel, Optional, datetime

TABLE = "vocabularies"


class Vocabulary(LanceModel):
    id: str
    name: str                                 # machine name, lowercase slug, 1..64
    workspace_name: str                       # FK -> workspaces.name
    label: str
    description: Optional[str] = None
    kind: str                                 # tags | categories
    term_policy: str = "open"                 # open | sealed
    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None
    created_at: datetime
    # UNIQUE (name, workspace_name)
