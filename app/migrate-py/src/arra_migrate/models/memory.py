"""`memories` -- tier 2, written in tier 1's column idiom. SPEC.md §3.4.

Field order here is the column order on disk, so it matches the ASCII in
discussion #14 rather than pydantic's alphabetical whim.
"""

from ._base import EMBEDDING_DIM, LanceModel, Optional, Vector, datetime

TABLE = "memories"


class Memory(LanceModel):
    id: str
    name: str

    # The isolation constraint. Every cross-table reference carries this, so a
    # cross-bank reference is a constraint violation, not a failed assert.
    workspace_name: str

    session_name: Optional[str] = None
    peer_name: Optional[str] = None          # who WROTE it
    subject_peer_name: Optional[str] = None  # who it is ABOUT

    # Free text guarded by a vocabulary, never an enum: adding a kind of memory
    # is a term insert, not a migration (§3.3).
    type: str = "note"
    content: str

    # NULLABLE ON PURPOSE. Text lands first, vectors backfill later, so an
    # embedder outage never blocks a write. Binding an embedding function into
    # the schema would put an external call on the write path -- the
    # un-transactional hazard §4.6 warns about.
    embedding: Optional[Vector(EMBEDDING_DIM)] = None

    created_at: datetime                      # when we LEARNED it
    valid_from: Optional[datetime] = None     # when it STARTED being true
    valid_to: Optional[datetime] = None       # NULL = still true

    sync_state: str = "pending"               # pending | synced | failed
    superseded_by: Optional[str] = None       # the reason lives in supersede_log, once
    superseded_at: Optional[datetime] = None

    # OPEN: issue #2 -- a bit, or replaced by `tier`? Carried across unchanged
    # rather than silently decided by writing this migration.
    is_active: bool = True

    h_metadata: Optional[str] = None          # user-visible JSON, as a string
    internal_metadata: Optional[str] = None   # internal JSON, as a string
