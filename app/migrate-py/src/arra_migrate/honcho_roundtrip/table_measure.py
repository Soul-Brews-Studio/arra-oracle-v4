"""Measure the table-level round trip: input vs REST read-back vs SQL read-back.

Issue #8, ruling R15 (2026-09-27 table-level update). After ``table_sql``'s
INSERTs land in a stock Honcho database, every v4 tier-1 column gets one
measured outcome on each read path:

  rest   Honcho's own REST API (``target.HttpHonchoTarget``), the path a stock
         Honcho client uses: exact / converted / not-exposed / mismatch.
  table  the same database read with SQL: exact / converted / lost / mismatch.

``exact`` means the same Python value (for text: the same code points, hence
the same UTF-8 bytes). ``converted`` means equal only after the conversion
``table_map`` documents for that column (timestamp[us] naive-UTC <->
timestamptz; JSON text <-> jsonb with NULL -> {}). Anything else is a
``mismatch`` with the row named in ``notes``. Missing or extra rows and a
changed message order are ``problems``.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .bundle import Tier1Bundle
from .table_map import REST_FIELDS, TIER1_TABLES, VERDICT_INDEX
from .target import HonchoTarget
from .wire import from_wire_timestamp

_KEYS = {
    "workspaces": ("name",),
    "peers": ("name",),
    "sessions": ("name",),
    "session_peers": ("session_name", "peer_name"),
    "messages": ("public_id",),
}


@dataclass
class TableReport:
    outcomes: dict[tuple[str, str], dict[str, str]] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def render(self) -> str:
        lines = ["TABLE-LEVEL ROUND TRIP (v4 target-19 tier-1 -> stock Honcho v3.2.0 SQL -> REST + SQL)"]
        for (table, col), o in sorted(self.outcomes.items(), key=lambda kv: (TIER1_TABLES.index(kv[0][0]), kv[0][1])):
            verdict = VERDICT_INDEX[(table, col)].verdict
            lines.append(f"  {table + '.' + col:<34} {verdict:<13} rest={o['rest']:<12} table={o['table']}")
        lines += [f"  note: {n}" for n in self.notes]
        lines += [f"  PROBLEM: {p}" for p in self.problems]
        return "\n".join(lines)


def read_rows_sql(psql: Callable[[str], str], workspace_name: str) -> dict[str, list[dict[str, Any]]]:
    """Every tier-1 row of *workspace_name*, straight from Postgres as JSON."""

    ws = "'" + workspace_name.replace("'", "''") + "'"
    out: dict[str, list[dict[str, Any]]] = {}
    for table in TIER1_TABLES:
        where = "name" if table == "workspaces" else "workspace_name"
        raw = psql(f'select coalesce(json_agg(t), \'[]\') from (select * from "{table}" where {where} = {ws}) t;')
        out[table] = json.loads(raw)
    return out


def _as_utc(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    return from_wire_timestamp(str(value))


def _compare(kind: str, given: Any, got: Any) -> str:
    if kind == "ts":
        return "converted" if _as_utc(given) == _as_utc(got) else "mismatch"
    if kind == "json":
        expected = {} if given is None else (json.loads(given) if isinstance(given, str) else given)
        return "converted" if expected == got else "mismatch"
    if type(given) is type(got) and given == got:
        return "exact"
    return "mismatch"


def _worst(statuses: list[str]) -> str:
    for s in ("mismatch", "converted"):
        if s in statuses:
            return s
    return "exact"


def _rest_rows(bundle: Tier1Bundle, target: HonchoTarget, workspace: str) -> dict[str, dict[tuple, dict[str, Any]]]:
    ws = target.get_workspace(workspace)
    sessions = [s["name"] for s in bundle.sessions]
    rest: dict[str, dict[tuple, dict[str, Any]]] = {
        "workspaces": {(ws["id"],): ws},
        "peers": {(p["id"],): p for p in target.list_peers(workspace)},
        "sessions": {(s["id"],): s for s in target.list_sessions(workspace)},
        "session_peers": {},
        "messages": {},
    }
    for s in sessions:
        for p in target.get_session_peers(workspace, s):
            rest["session_peers"][(s, p["id"])] = {"workspace_id": p["workspace_id"], "session_id": s, "id": p["id"]}
        for m in target.list_messages(workspace, s):
            rest["messages"][(m["id"],)] = m
    return rest


def _check_order(bundle: Tier1Bundle, target: HonchoTarget, workspace: str, report: TableReport) -> None:
    for s in [x["name"] for x in bundle.sessions]:
        wanted = [m["public_id"] for m in sorted(bundle.messages, key=lambda m: m["seq_in_session"]) if m["session_name"] == s]
        got = [m["id"] for m in target.list_messages(workspace, s)]
        if got != wanted:
            report.problems.append(f"messages order in {s!r}: REST {got} != seq_in_session order {wanted}")


def measure_table_round_trip(bundle: Tier1Bundle, target: HonchoTarget, sql_rows: dict[str, list[dict[str, Any]]]) -> TableReport:
    report = TableReport()
    workspace = bundle.workspaces[0]["name"]
    rest = _rest_rows(bundle, target, workspace)
    sql = {t: {tuple(r[k] for k in _KEYS[t]): r for r in rows} for t, rows in sql_rows.items()}

    for table in TIER1_TABLES:
        given = {tuple(r[k] for k in _KEYS[table]): r for r in getattr(bundle, table)}
        if set(sql[table]) != set(given):
            report.problems.append(f"{table}: SQL rows {sorted(sql[table])} != input {sorted(given)}")
        departed = {k for k, r in given.items() if table == "session_peers" and r.get("left_at") is not None}
        expected_rest = set(given) - departed
        if table == "session_peers" and departed:
            listed = departed & set(rest[table])
            report.notes.append(
                f"session_peers: {len(departed)} departed row(s) (left_at set) {'ARE' if listed else 'are NOT'} "
                "listed by GET .../sessions/{id}/peers -- Honcho reads left_at as 'no longer a member'"
            )
            expected_rest = set(given) - (departed - listed)
        if set(rest[table]) != expected_rest:
            report.problems.append(f"{table}: REST rows {sorted(rest[table])} != expected {sorted(expected_rest)}")

        for (t, col), verdict in VERDICT_INDEX.items():
            if t != table:
                continue
            table_status = "lost"
            if verdict.honcho_column is not None:
                statuses = [_compare(verdict.kind, row.get(col), sql[table].get(k, {}).get(verdict.honcho_column)) for k, row in given.items()]
                table_status = _worst(statuses)
            rest_status = "not-exposed"
            if (table, col) in REST_FIELDS:
                field_name = REST_FIELDS[(table, col)]
                statuses = [_compare(verdict.kind, given[k].get(col), rest[table][k].get(field_name)) for k in expected_rest & set(rest[table])]
                rest_status = _worst(statuses)
            for status, path in ((table_status, "table"), (rest_status, "rest")):
                if status == "mismatch":
                    report.notes.append(f"{table}.{col}: {path} read-back differs from the input")
            report.outcomes[(table, col)] = {"rest": rest_status, "table": table_status}
            if verdict.kind == "json":
                collapsed = sum(1 for r in given.values() if r.get(col) is None)
                if collapsed:
                    report.notes.append(f"{table}.{col}: {collapsed} NULL value(s) came back as {{}} (NULL vs {{}} lost)")

    _check_order(bundle, target, workspace, report)
    return report
