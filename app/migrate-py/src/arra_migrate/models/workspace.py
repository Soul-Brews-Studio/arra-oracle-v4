"""`workspaces` -- tier 1, Honcho's, byte-compatible. SPEC.md §3.1.

THE one alias: this is "bank" in prose and URLs, `workspace_name` in the schema.
There is no `banks` table and no `bank_id` column. `name` is the FK target
everywhere -- never `id`.
"""

from ._base import LanceModel, Optional, datetime

TABLE = "workspaces"


class Workspace(LanceModel):
    id: str                                   # nanoid(21)
    name: str                                 # UNIQUE -- the FK target everywhere
    created_at: datetime
    h_metadata: Optional[str] = None          # user-visible
    internal_metadata: Optional[str] = None
    configuration: Optional[str] = None

    # +v4, nullable. DESCRIPTIVE ONLY, never behavioural -- Hindsight's bank
    # concept minus the traits.
    mission: Optional[str] = None
