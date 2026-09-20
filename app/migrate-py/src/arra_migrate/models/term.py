"""`terms` -- Drupal-shaped taxonomy. SPEC.md §3.3.

`weight` is the owner's chosen order, not an alphabetical accident.
`parent_id` nests (ON DELETE SET NULL).
"""

from ._base import LanceModel, Optional, datetime

TABLE = "terms"


class Term(LanceModel):
    id: str
    vocabulary_id: str                        # FK -> vocabularies, ON DELETE CASCADE
    name: str                                 # 1..128
    description: Optional[str] = None
    parent_id: Optional[str] = None           # FK -> terms, ON DELETE SET NULL
    weight: float = 0.0
    h_metadata: Optional[str] = None
    created_at: datetime
    # UNIQUE (vocabulary_id, name)
