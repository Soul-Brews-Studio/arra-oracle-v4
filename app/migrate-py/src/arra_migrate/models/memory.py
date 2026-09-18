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

    # Honcho's THREE columns, on the row, not a reconciler table (models.py:411-417).
    # One timestamp cannot tell "never tried" from "tried and failed", and cannot
    # count retries -- sync_attempts is what lets a backfill give up on a poison
    # row instead of re-embedding it forever (SPEC §4.6.1). Shipped with only
    # sync_state on 2026-09-18; the other two were lost in transcription and
    # `--check` could not see it, because it compares this file against the disk.
    sync_state: str = "pending"               # pending | synced | failed
    last_sync_at: Optional[datetime] = None   # when the derived index caught up
    sync_attempts: int = 0
    superseded_by: Optional[str] = None       # the reason lives in supersede_log, once
    superseded_at: Optional[datetime] = None

    # DECIDED 2026-09-18, issue #2: stays a bit. v3 shipped `tier` + decay and
    # wired the sweep to a stats read (store.ts:111), so nothing ever demoted --
    # a tier nothing demotes is decoration. Forgetting in v4 is superseded_by
    # and valid_from/valid_to, both explicit. `tier` can arrive later as one
    # nullable column plus a real scheduled sweep (§15.2 permits it).
    is_active: bool = True

    h_metadata: Optional[str] = None          # user-visible JSON, as a string
    internal_metadata: Optional[str] = None   # internal JSON, as a string
