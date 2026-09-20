"""KNOWLEDGE (5): one node shape, immutable revisions, derived projections.

Authority lives on ``node_revisions`` as canonical scalar columns plus the two
REQUIRED association snapshots. ``node_revision_terms`` and ``revision_links``
are derived, rebuildable projections of those snapshots -- they carry no
independent id and are not publication prerequisites (independent review,
2026-09-20, repairs 1-4).
"""

from ._base import LanceModel, Optional, datetime

NODES = "nodes"
NODE_REVISIONS = "node_revisions"
NODE_REVISION_TERMS = "node_revision_terms"
REVISION_LINKS = "revision_links"
SUPERSEDE_LOG = "supersede_log"


class Node(LanceModel):
    id: str
    workspace_name: str
    # Nullable: a node exists before its first revision is ACCEPTED. The head
    # must match workspace AND node_id -- service-enforced, not physical.
    current_revision_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class NodeRevision(LanceModel):
    id: str
    workspace_name: str
    node_id: str
    # Required Int64 ordinal, meaningful on ACCEPTED ancestry only. Rows off
    # that ancestry may legitimately share an ordinal, so NO table-wide
    # (W, node_id, revision_no) uniqueness is claimed here -- #26 decides both
    # the numbering rule and what publication state a row is actually in.
    revision_no: int
    base_revision_id: Optional[str] = None    # expected previous accepted revision
    operation_id: str                         # retry / idempotency key, scoped (W, operation_id)

    title: str
    body: str
    body_format: str
    fields: str                               # validated extension JSON, "{}" when empty

    author_peer_name: Optional[str] = None
    observer_peer_name: Optional[str] = None
    subject_peer_name: Optional[str] = None
    session_name: Optional[str] = None

    is_active: bool = True
    valid_from: Optional[datetime] = None
    valid_to: Optional[datetime] = None
    change_reason: Optional[str] = None
    created_at: datetime

    # Authority envelope. schema_version versions THIS physical row shape;
    # canonical_version names the canonicalization the digest was computed
    # under. Being non-null UTF-8 proves PRESENCE only: it does not prove the
    # version is one the service recognizes, nor that the digest was recomputed
    # from the row it sits on. Recognizing the version and verifying the digest
    # are deferred service validation, not properties of this column.
    schema_version: int
    canonical_version: str
    content_digest: str                       # lowercase sha256 hex

    # REQUIRED association snapshots. Empty is the explicit string "[]",
    # never NULL -- "no terms" and "unknown terms" must not share a value.
    term_snapshot_json: str
    link_snapshot_json: str

    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None


class NodeRevisionTerm(LanceModel):
    """Derived projection. Key (workspace_name, revision_id, term_id)."""

    workspace_name: str
    revision_id: str
    term_id: str
    vocabulary_id: str                        # validated owner, not alternate authority
    vocabulary_name_snapshot: str
    term_name_snapshot: str
    label_snapshot: Optional[str] = None
    position: int


class RevisionLink(LanceModel):
    """Derived projection. Key (workspace_name, revision_id, position); no random id."""

    workspace_name: str
    revision_id: str
    position: int
    relation: str                             # supports | contradicts | derived_from | discusses | corrects | related_to
    target_kind: str                          # node_revision | trace | message | session | relic_event | relic_session | code | commit | issue | discussion | url
    target: str                               # validated discriminated JSON, as text
    target_key: str                           # versioned canonical locator digest (derived)
    excerpt: Optional[str] = None
    content_hash: Optional[str] = None
    captured_at: Optional[datetime] = None
    capture_status: str                       # captured | locator_only | unresolved
    note: Optional[str] = None


class SupersedeLog(LanceModel):
    id: int
    workspace_name: str
    old_id: str
    old_revision_id: str                      # [P] pins the compared version
    old_title: Optional[str] = None
    old_type: Optional[str] = None
    old_source: Optional[str] = None
    new_id: Optional[str] = None              # NULL pair = retire without replacement
    new_revision_id: Optional[str] = None     # [P]
    new_title: Optional[str] = None
    new_source: Optional[str] = None
    reason: str                               # required in the target (§9); active registry has it nullable
    peer_name: Optional[str] = None
    superseded_at: datetime
    operation_id: str                         # [P] scoped (W, operation_id), serialized writer
    h_metadata: Optional[str] = None
