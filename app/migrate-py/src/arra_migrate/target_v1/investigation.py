"""INVESTIGATION (2): traces and their hits. DESIGN.md §10.

``traces`` keeps its LEGACY integer epoch-millisecond timestamps exactly as the
active registry declares them. Converting them to timestamp[us] is a migration
decision the design forbids making silently (§4: "Do not silently reinterpret
legacy epoch milliseconds as microseconds"). That retention rule covers fields
the target RETAINS; it does not argue for carrying forward a field the design
deliberately removes.
"""

from ._base import LanceModel, Optional, datetime

TRACES = "traces"
TRACE_HITS = "trace_hits"


class Trace(LanceModel):
    id: str
    name: str
    workspace_name: str
    session_name: Optional[str] = None
    peer_name: Optional[str] = None
    query: str
    mode: Optional[str] = None
    session_id: Optional[str] = None          # names an external .jsonl; no FK by design
    session_from_ts: Optional[int] = None
    session_to_ts: Optional[int] = None
    friction_score: Optional[float] = None
    confidence: Optional[str] = None
    parent_id: Optional[str] = None
    prev_id: Optional[str] = None
    depth: int = 0
    status: str = "raw"
    # NOT HERE: `distilled_to` / `distilled_at`. The active 15 keep that legacy
    # singular pointer unchanged, but DESIGN.md section 10 replaces it -- a
    # trace may feed many conclusions and a conclusion may cite many traces,
    # which one nullable column cannot express. Lookup goes through
    # `revision_links`; any "distilled to" display is DERIVED from those links,
    # never a second writable authority carried forward for compatibility.
    h_metadata: Optional[str] = None
    internal_metadata: Optional[str] = None
    created_at: int                           # legacy epoch ms
    updated_at: int                           # legacy epoch ms


class TraceHit(LanceModel):
    workspace_name: str                       # [P] explicit scope (was inferred via traces)
    trace_id: str
    kind: str
    ref: str
    # [P] DESIGN.md section 10: a hit carries a STRUCTURED locator, not only the
    # display `ref` string. Required, same as revision_links.target. Storing
    # the JSON is physical shape only -- validating the discriminated union
    # against `kind` is a service gate, not proven by this column existing.
    target: str
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    excerpt: Optional[str] = None             # [P] bounded captured evidence
    content_hash: Optional[str] = None        # [P] digest of that capture
    captured_at: Optional[datetime] = None    # [P]
    note: Optional[str] = None
    position: int = 0
