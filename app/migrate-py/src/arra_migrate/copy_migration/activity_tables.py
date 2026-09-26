"""Direct copy of ``traces``, ``trace_hits``, ``mcp_calls`` and ``connections``.

Int64 time inventory, retained RAW (no unit reinterpretation, DESIGN §4):
  traces.session_from_ts / session_to_ts / created_at / updated_at   epoch ms
  mcp_calls.created_at                                                epoch ms
The one converted legacy time, ``traces.distilled_at``, is not a target
column; the knowledge plan carries it into the conclusion revision's
``internal_metadata`` (R17), never into ``captured_at``.

``traces.status``: the legacy closed set is raw | distilled | retired; the trace
kernel's closed set is open | complete | abandoned (trace-v1.md), and a stored
value outside it reads back as ``integrity_failure``. The copy maps
raw -> open, distilled -> complete, retired -> abandoned and records the legacy
value on the row's report record. This mapping is an IMPLEMENTER decision made
tonight, not part of rulings R11/R17; it is named in the report's policies and
in the target-v1-decisions amendment so it can be overturned.

``trace_hits`` is reported UNRESOLVED row by row: the target requires a
structured ``target`` locator validated against an evidence kind, and a legacy
free-text ``ref`` with kind ``file`` does not determine one without inventing
it. The legacy rows stay intact in the source.
"""

from __future__ import annotations

from typing import Any

from .ids import IdCollision
from .state import CopyState
from .timestamps import first_sub_ms

Row = dict[str, Any]

#: legacy status -> trace-v1 status. Target values already in the closed set pass through.
TRACE_STATUS_MAP = {"raw": "open", "distilled": "complete", "retired": "abandoned"}
TARGET_TRACE_STATUSES = ("open", "complete", "abandoned")
_NULLABLE_NONEMPTY = ("session_name", "peer_name", "mode", "session_id", "confidence")


def copy_traces(rows: list[Row], state: CopyState) -> list[Row]:
    accepted: list[Row] = []
    names: set[tuple[str, str]] = set()
    for row in rows:
        ws, key = row["workspace_name"], row["id"]
        if ws not in state.workspaces:
            state.unresolved("traces", key, ws, "workspace_unresolved", "/workspace_name")
            continue
        if not row["name"] or not row["query"]:
            state.rejected("traces", key, ws, "invalid_value", "/name" if not row["name"] else "/query")
            continue
        empty = next((f for f in _NULLABLE_NONEMPTY if row[f] == ""), None)
        if empty is not None:
            state.rejected("traces", key, ws, "invalid_value", f"/{empty}", detail="empty text where null or nonempty is required")
            continue
        if (row["status"] not in TRACE_STATUS_MAP and row["status"] not in TARGET_TRACE_STATUSES) or row["depth"] < 0:
            state.rejected("traces", key, ws, "invalid_value", "/status" if row["depth"] >= 0 else "/depth")
            continue
        if (ws, row["name"]) in names:
            state.rejected("traces", key, ws, "duplicate_name", "/name")
            continue
        try:
            target = state.ids.assign("traces", ws, key)
        except IdCollision as error:
            state.rejected("traces", key, ws, "id_collision", "/id", detail=str(error))
            continue
        names.add((ws, row["name"]))
        state.traces[key] = {"workspace": ws, "id": target}
        accepted.append(row)

    out = []
    for row in accepted:
        ws, key = row["workspace_name"], row["id"]
        mapped = {}
        for column in ("parent_id", "prev_id"):
            legacy = row[column]
            hit = state.traces.get(legacy) if legacy is not None else None
            resolved = hit is not None and hit["workspace"] == ws
            mapped[column] = hit["id"] if resolved else None
            if legacy is not None:
                state.pointer(f"traces.{column}", key, ws, resolved, code="trace_unresolved",
                              detail=f"legacy {column}={legacy!r}")
        status = TRACE_STATUS_MAP.get(row["status"], row["status"])
        if status != row["status"]:
            state.report.policies["trace_status_mapped"] += 1
        state.migrated("traces", key, ws, state.traces[key]["id"],
                       detail=f"status {row['status']} -> {status}" if status != row["status"] else None)
        target_row = {k: v for k, v in row.items() if k not in ("distilled_to", "distilled_at")}
        out.append({**target_row, "id": state.traces[key]["id"], "status": status, **mapped})
    return out


def copy_trace_hits(rows: list[Row], state: CopyState) -> list[Row]:
    for row in rows:
        trace = state.traces.get(row["trace_id"])
        state.unresolved(
            "trace_hits", f"{row['trace_id']}|{row['position']}", trace["workspace"] if trace else None,
            "locator_unmappable", "/target",
            detail=f"legacy kind={row['kind']!r} ref={row['ref']!r} has no structured evidence locator",
        )
    return []


def copy_mcp_calls(rows: list[Row], state: CopyState) -> list[Row]:
    out = []
    seen: set[str] = set()
    for row in rows:
        ws, key = row["workspace_name"], row["id"]
        if ws not in state.workspaces:
            state.unresolved("mcp_calls", key, ws, "workspace_unresolved", "/workspace_name")
            continue
        if not key or key in seen:
            state.rejected("mcp_calls", key, ws, "duplicate_id" if key else "invalid_value", "/id")
            continue
        seen.add(key)
        state.migrated("mcp_calls", key, ws, key)
        # No source identity to attach: transport columns stay NULL.
        out.append({**row, "connection_id": None, "principal": None})
    return out


def copy_connections(rows: list[Row], state: CopyState) -> list[Row]:
    out = []
    seen: set[str] = set()
    for row in rows:
        ws, key = row["workspace_name"], row["id"]
        if ws not in state.workspaces:
            state.unresolved("connections", key, ws, "workspace_unresolved", "/workspace_name")
            continue
        bad = first_sub_ms(row, ("first_seen", "last_seen"))
        if bad is not None:
            state.rejected("connections", key, ws, "sub_millisecond_timestamp", f"/{bad}")
            continue
        if key in seen or row["requests"] < 0 or row["tool_calls"] < 0:
            state.rejected("connections", key, ws, "duplicate_id" if key in seen else "invalid_value",
                           "/id" if key in seen else "/requests")
            continue
        seen.add(key)
        state.migrated("connections", key, ws, key)
        out.append(dict(row))
    return out
