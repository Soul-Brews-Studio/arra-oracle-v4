"""`traces` -- tier 3. SPEC.md §14.2. 16 columns (was 23).

The subsystem with no equivalent anywhere else in the fleet, and the one most
likely to be lost in a rewrite.

THE ANCHOR is (session_id, session_from_ts, session_to_ts) -- a trace's prose is
a convenience; that triple is what a HUMAN verifies against. `session_id` has NO
FK deliberately: it names a .jsonl that lives outside, which v4 does not own
(§14.6.1).
"""

from ._base import LanceModel, Optional

TABLE = "traces"


class Trace(LanceModel):
    id: str
    name: str                                 # slug, vault already names these HHMM_kebab-slug
    workspace_name: str                       # FK -> workspaces.name
    session_name: Optional[str] = None        # which room it ran in
    peer_name: Optional[str] = None           # who ran it (renamed from actor_peer_name -- one fleet, one word)
    query: str                                # what was asked

    # FREE TEXT. Invocation strings, not a classification:
    # deep(56) | smart | synthesis | deep-dig | 'deep --dig'
    mode: Optional[str] = None

    session_id: Optional[str] = None          # the .jsonl UUID. NO FK -- it lives outside
    session_from_ts: Optional[int] = None     # } THE ANCHOR: min/max of children's range,
    session_to_ts: Optional[int] = None       # } copied forward unchanged at every level

    # 0.0-1.0. The one signal pointing at what the corpus is MISSING. You sort by it.
    friction_score: Optional[float] = None

    # CONTROLLED. The corpus had 5 spellings of 3 states (high|HIGH|PROVEN|medium|
    # medium-high); normalised once on import, original kept in metadata --
    # auditable, not lossy (ketiv/qere).
    confidence: Optional[str] = None

    parent_id: Optional[str] = None           # } tree
    prev_id: Optional[str] = None             # } sequence -- ONE source per edge (§14.4)
    depth: int = 0

    # CONTROLLED: raw | distilled | retired.
    # Tier 3 already has a 3-state lifecycle while tier 2 has a bit -- open
    # question 2 in #12, and the precedent that would make `tier` on memories
    # consistent rather than exceptional.
    status: str = "raw"

    distilled_to: Optional[str] = None        # FK -> memories.id
    distilled_at: Optional[int] = None
    h_metadata: Optional[str] = None          # target · project · coverage · agent_count · duration_ms
    internal_metadata: Optional[str] = None
    created_at: int
    updated_at: int
    # UNIQUE (name, workspace_name)
    # CUT: `scope` -- v3's SQL had it; the 72-file survey measured query/target/mode
    # at 72/72 and never established a rate for scope at all.
