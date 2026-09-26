"""Create the 19 target tables and copy the directly mappable legacy tables.

Python is the schema owner (AGENTS.md): it creates all 19 EMPTY tables from
``target_v1`` into the fresh candidate, then appends the rows of the twelve
legacy tables that map one-to-one. The knowledge tables (``nodes``,
``node_revisions``, ``node_revision_terms``, ``revision_links``,
``supersede_log``, ``search_chunks_v1``) and the reserved/R11 taxonomy rows are
written by the TypeScript kernel afterwards -- Python never builds revision
bytes (revision_v1.py: Bun is the one canonicalizer).

Rows are sorted by legacy key before they are handed to a table function, so
the candidate's content does not depend on the source's fragment order and a
rerun into a second empty candidate produces identical rows.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from .activity_tables import (
    copy_connections,
    copy_mcp_calls,
    copy_trace_hits,
    copy_traces,
)
from .context_tables import (
    copy_messages,
    copy_peers,
    copy_read_cursors,
    copy_session_peers,
    copy_sessions,
    copy_workspaces,
)
from .state import CopyState
from .taxonomy_tables import copy_terms, copy_vocabularies

Row = dict[str, Any]

#: Dependency order: every lookup a table needs is filled by an earlier one.
DIRECT_TABLES: tuple[tuple[str, Callable[[list[Row], CopyState], list[Row]], Callable[[Row], Any]], ...] = (
    ("workspaces", copy_workspaces, lambda r: r["id"]),
    ("peers", copy_peers, lambda r: r["id"]),
    ("sessions", copy_sessions, lambda r: r["id"]),
    ("session_peers", copy_session_peers,
     lambda r: (r["workspace_name"], r["session_name"], r["peer_name"], r["joined_at"])),
    ("messages", copy_messages, lambda r: (r["workspace_name"], r["session_name"], r["seq_in_session"], r["id"])),
    ("vocabularies", copy_vocabularies, lambda r: r["id"]),
    ("terms", copy_terms, lambda r: r["id"]),
    ("traces", copy_traces, lambda r: r["id"]),
    ("trace_hits", copy_trace_hits, lambda r: (r["trace_id"], r["position"])),
    ("mcp_calls", copy_mcp_calls, lambda r: r["id"]),
    ("connections", copy_connections, lambda r: r["id"]),
    ("read_cursors", copy_read_cursors, lambda r: (r["session_name"], r["peer_name"])),
)


def create_target_tables(candidate_db: Any) -> None:
    """All 19, empty, in manifest order. The candidate was verified empty."""

    for name in TARGET_TABLE_NAMES:
        candidate_db.create_table(name, schema=TARGET_TABLES[name])


def discard_candidate(candidate_db: Any) -> None:
    """A failed run leaves NO table behind.

    A half-written candidate still has the 19-table SHAPE, which is all
    ``assertTargetDataset`` checks, so it could be mounted by mistake. Every
    table in the candidate is this run's own: preflight proved the directory
    empty (bar the gate's lock file) and the caller still holds the writer
    gate, so nobody else can have written one. Only target table names are
    dropped; the lock file stays with the gate.
    """

    for name in candidate_db.table_names(limit=1000):
        if name in TARGET_TABLE_NAMES:
            candidate_db.drop_table(name)


def read_rows(source_db: Any, name: str) -> list[Row]:
    return source_db.open_table(name).to_arrow().to_pylist()


def copy_direct_tables(source_db: Any, candidate_db: Any, state: CopyState) -> None:
    for name, copy, order in DIRECT_TABLES:
        rows = sorted(read_rows(source_db, name), key=order)
        state.report.rows_in[name] = len(rows)
        built = copy(rows, state)
        if built:
            model = TARGET_TABLES[name]
            fields = list(model.model_fields)
            candidate_db.open_table(name).add([model(**{f: row[f] for f in fields}) for row in built])
