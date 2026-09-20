"""`memory_terms` -- the join. Both sides CASCADE; PK is the pair."""

from ._base import LanceModel

TABLE = "memory_terms"


class MemoryTerm(LanceModel):
    memory_id: str                            # FK -> memories, ON DELETE CASCADE
    term_id: str                              # FK -> terms,    ON DELETE CASCADE
