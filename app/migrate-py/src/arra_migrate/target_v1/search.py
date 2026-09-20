"""SEARCH (1): the rebuildable derived table. DESIGN.md §11.

Physical shape is pinned here. The embedding MODEL / profile policy that fills
``embedding`` is not settled by this file; ``embedding_profile`` is a string so
that decision can land without a schema change.
"""

from ._base import EMBEDDING_DIM_V1, LanceModel, Optional, Vector, datetime

SEARCH_CHUNKS_V1 = "search_chunks_v1"


class SearchChunkV1(LanceModel):
    id: str                                   # deterministic from W/revision/profile/chunk
    workspace_name: str
    node_id: str
    revision_id: str
    chunk_index: int
    text: str                                 # exact prepared text
    content_hash: str
    chunker_version: str
    embedding_profile: str
    # Nullable: text lands first, vectors arrive later or never.
    embedding: Optional[Vector(EMBEDDING_DIM_V1)] = None
    # REQUIRED. Section 11 copies the filter metadata of a revision that, by
    # the exactly-one-type policy of section 7, always has a type term. A
    # nullable column here would encode "chunk of a typeless revision", which
    # the taxonomy does not permit -- and no staged/pending exception is
    # carved out, because `status` already carries staging.
    type_term_id: str
    term_ids: list[str]                       # copied filter metadata; [] when none. Element nullability pinned in golden.
    observer_peer_name: Optional[str] = None
    subject_peer_name: Optional[str] = None
    session_name: Optional[str] = None
    status: str                               # pending | ready | failed
    attempts: int = 0
    last_attempt_at: Optional[datetime] = None
    embedded_at: Optional[datetime] = None
    error_code: Optional[str] = None
