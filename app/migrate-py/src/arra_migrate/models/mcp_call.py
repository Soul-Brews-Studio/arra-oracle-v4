"""`mcp_calls` -- non-optional call log. SPEC.md §6.3.

Successes AND failures both. "The model said it saved that" is not evidence a
row exists.

`status` is a COLUMN, not a JSON flag -- "show me every call that errored" is
the query this table exists to answer, and a JSON probe cannot use an index.
`workspace_name` is NOT NULL; v3's call log had none, one of two isolation holes.
"""

from ._base import LanceModel, Optional

TABLE = "mcp_calls"


class McpCall(LanceModel):
    id: str                                   # nanoid(21)
    workspace_name: str                       # <== v3's call log had NONE
    session_name: Optional[str] = None
    peer_name: Optional[str] = None
    tool: str                                 # the tool name as invoked
    status: str                               # CONTROLLED: ok | error
    duration_ms: int = 0
    # input is TRUNCATED AT WRITE TIME, never at read
    h_metadata: Optional[str] = None          # input · result summary · error message · connection id
    internal_metadata: Optional[str] = None
    created_at: int
