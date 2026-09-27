"""`instance_audit` -- the INSTANCE-level audit sink (#31 maint-audit, Nat
2026-09-28 D4b), NOT a tenant table.

`POST /api/backfill` and `POST /api/reindex` admit a GLOBAL action: no
workspace, and `mcp_calls.workspace_name` is NOT NULL, so neither route can
ever write a tenant `mcp_calls` row without inventing a sentinel workspace,
which D4b forbids. This model is the schema authority for the separate
dataset the TS server opens at the same data root (`instanceAudit
.openInstanceAuditTable.ts`) -- Python still declares the Arrow schema
(AGENTS.md: "Python declares the schema, TS never does"), even though this
table is outside `TABLES`/`TIER_1`/`TIER_2`/`TIER_3` and is never created by
`python -m arra_migrate` against a workspace: it is intentionally NOT part of
the 15/19-table tenant migration, so it is declared here but deliberately
excluded from `models/__init__.py`'s `TABLES` registry.

`principal_id` is nullable: a REFUSED call (403, or no credential at all) has
no principal, and D4b requires a row on refusal exactly as much as on
admission -- an inferred-from-data schema would crash the first time a
refusal landed before any admitted row (measured, see instanceAudit
.openInstanceAuditTable.ts's header).
"""

from ._base import LanceModel, Optional

TABLE = "instance_audit"


class InstanceAudit(LanceModel):
    id: str                                    # ia_<ts36>_<rand>
    principal_id: Optional[str] = None          # NULL on every refusal
    route: str                                  # "/api/backfill" | "/api/reindex"
    action: str                                 # "maintenance:backfill" | "maintenance:reindex"
    outcome: str                                # "admitted" | "refused"
    status: str                                 # "ok" | "error"
    input_summary: str                          # truncated + redacted (R5), never raw
    started_at: int                             # epoch ms
    finished_at: int                            # epoch ms
    duration_ms: int = 0
    request_id: str
