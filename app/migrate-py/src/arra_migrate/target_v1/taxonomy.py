"""TAXONOMY (2): one classification mechanism. DESIGN.md §7.

``type`` and ``memory_horizon`` are reserved VOCABULARIES, not enums and not a
content_types registry. The [P] policy columns make cardinality / required /
hierarchy independent validated rules.
"""

from ._base import LanceModel, Optional, datetime

VOCABULARIES = "vocabularies"
TERMS = "terms"


class Vocabulary(LanceModel):
    id: str
    name: str
    workspace_name: str
    label: str
    description: Optional[str] = None
    kind: str                                 # tags | categories
    term_policy: str = "open"                 # open | sealed
    cardinality: str                          # [P] one | many
    required: bool                            # [P]
    hierarchy: str                            # [P] flat | tree
    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None
    created_at: datetime


class Term(LanceModel):
    id: str
    workspace_name: str                       # [P] explicit scope; active registry infers it via vocabulary
    vocabulary_id: str
    name: str
    description: Optional[str] = None
    parent_id: Optional[str] = None
    weight: float = 0.0
    is_active: bool = True                    # [P] prevents NEW assignments; old snapshots unaffected
    h_metadata: Optional[str] = None
    created_at: datetime
