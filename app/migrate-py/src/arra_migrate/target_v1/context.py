"""CONTEXT (1): explicit session chains. DESIGN.md §5 "Session names, original IDs, and chains"."""

from ._base import LanceModel, Optional, datetime

SESSION_LINKS = "session_links"


class SessionLink(LanceModel):
    id: str
    workspace_name: str
    from_session_name: str                    # later session / child
    to_session_name: str                      # earlier session / parent
    relation: str                             # continues | forked_from | related_to (service-validated)
    evidence_ref: Optional[str] = None        # typed external locator JSON, as text
    created_by_peer_name: Optional[str] = None
    created_at: datetime
