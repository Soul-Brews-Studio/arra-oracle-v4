"""`supersede_log` -- "what changed, when, and why". SPEC.md §4.2.

Two things worth not undoing:

- `workspace_name` is NOT NULL. v3's equivalent had NO tenant column at all and
  failed OPEN -- an audit log that leaks across tenants is worse than no audit
  log, because people trust it (#10).
- `old_id` / `new_id` are deliberately NOT enforced FKs. They are snapshotted so
  the log outlives the row it describes. This is the ONE place in the schema
  where a reference may dangle, and §4.2 documents it nowhere (found by drawing
  #14).
"""

from ._base import LanceModel, Optional, datetime

TABLE = "supersede_log"


class SupersedeLog(LanceModel):
    id: int                                   # autoincrement -- the log is ORDERED
    workspace_name: str                       # <== v3 HAD NO TENANT COLUMN HERE
    old_id: str
    old_title: Optional[str] = None           # }
    old_type: Optional[str] = None            # }  SNAPSHOTTED at supersede time
    old_source: Optional[str] = None          # }
    new_id: Optional[str] = None              # null = retired with no replacement
    new_title: Optional[str] = None
    new_source: Optional[str] = None
    reason: Optional[str] = None              # the ONLY copy -- never duplicated onto memories (§14.4)
    peer_name: Optional[str] = None
    superseded_at: datetime
    h_metadata: Optional[str] = None
