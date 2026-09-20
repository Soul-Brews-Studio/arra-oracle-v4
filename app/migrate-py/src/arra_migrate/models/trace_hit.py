"""`trace_hits` -- one join table replaces six. SPEC.md §14.3.

~95% cleanly extractable, measured across all 72 vault trace files.
  file   -> path:line-line   (src/ssh.ts:69-100)
  commit -> 7-char hash      (6b65f67)

WARNING: `kind` is declared controlled and its closed set is NEVER LISTED in
§14.3 -- it gives file, commit, issue as examples and stops. A direct instance
of open question 4 in #12. Left as free text here rather than inventing the set.
"""

from ._base import LanceModel, Optional

TABLE = "trace_hits"


class TraceHit(LanceModel):
    trace_id: str                             # FK -> traces, ON DELETE CASCADE
    kind: str                                 # CONTROLLED: file | commit | issue ... (set undefined)
    ref: str                                  # the reference, canonical form
    line_start: Optional[int] = None          # when kind='file' and a range was cited
    line_end: Optional[int] = None
    note: Optional[str] = None                # the one-line "why this matched"
    position: int = 0                         # order as presented
