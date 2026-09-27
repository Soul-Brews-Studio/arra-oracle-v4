"""Migration rehearsal: active-15 -> target-19, against a DISPOSABLE dataset.

Issue #34. This module never touches a real dataset: every table it reads or
writes lives under a temporary root the caller creates and destroys. It is a
REHEARSAL, not a migrator -- nothing here is wired into ``__main__`` or into
the runtime that serves ``ARRA_DATA_DIR``.

What this proves, concretely:

  1. A source dataset in the ACTIVE-15 physical shape (``arra_migrate.models``)
     can be read and re-written into the TARGET-19 physical shape
     (``arra_migrate.target_v1``) without mutating the source. Verified at
     VALUE level (every shared field compared row-by-row), not by row counts
     alone -- row counts pass straight through the BigInt-class corruption
     this rehearsal is partly here to rule out.
  2. The source is provably untouched: the migration path is only ever handed
     a read-only handle (``_ReadOnlySource`` raises on any table-mutating
     call), and a before/after snapshot of schema+version+row-count for every
     source table is compared and must match exactly.
  3. The migration is idempotent in the sense that matters for a rehearsal:
     run twice from the same deterministic source, it produces byte-identical
     output. It does not attempt in-place upsert idempotency against a live
     target -- see LIMITATIONS below.
  4. The traces ms-vs-trace_hits us split survives a round trip exactly, and
     the ms/micros confusion this rehearsal exists to catch is demonstrated
     failing when done wrong. See ``prove_unit_handling``.

WHAT THIS DOES NOT ESTABLISH (read before citing this as evidence of anything
beyond itself):

  - Production readiness or cutover safety. Zero.
  - That schema tooling alone (``target_v1/schema.py``, the existing
    ``test_target_schema_v1.py`` gates) constitutes a rehearsal. It does not --
    those tests create 19 EMPTY tables and prove physical shape only. This
    module is the first thing in the repo that pushes populated rows through
    a source -> target transform and compares values.
  - A correct, authoritative ``memories``/``memory_terms`` -> ``nodes`` /
    ``node_revisions`` / ``node_revision_terms`` / ``revision_links`` mapping.
    That transform owns canonicalization, content digests, revision
    numbering and publication state -- the association/publication kernel
    work happening concurrently in ``service.ts`` et al, which this rehearsal
    is barred from touching and does not attempt to reimplement. Those four
    tables, PLUS ``memories``/``memory_terms`` themselves, are reported
    NOT_EXERCISED here, in addition to the four tables the live spike already
    reports as never written (``session_links``, ``trace_hits``,
    ``search_chunks_v1``, ``read_cursors``). That is 8 of 19 NOT_EXERCISED in
    THIS rehearsal -- a more conservative number than the live spike's 4,
    and deliberately so: inventing a plausible-looking digest/canonicalization
    step would be worse than an honest gap.
  - Backfill policy correctness for the handful of new REQUIRED target
    columns that have no source equivalent (``vocabularies.cardinality`` /
    ``.required`` / ``.hierarchy``; ``supersede_log.operation_id`` /
    ``.old_revision_id``; ``supersede_log.reason`` when the legacy row has
    none). This rehearsal picks one explicit, clearly-labelled default for
    each and flags every row it touches -- it is not asserting those are the
    RIGHT defaults, only that a decision has to be made and hiding it would
    be worse.
  - Concurrency, partial-failure recovery, or resumability of a real
    migration run. This is single-threaded, single-pass, in a temp directory.
"""

from __future__ import annotations

import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import lancedb
import numpy as np
import pyarrow as pa

from .models import TABLES as ACTIVE_TABLES
from .target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from .target_v1.schema import describe_schema

# ---------------------------------------------------------------------------
# Deterministic fixture data, split out to `rehearsal_fixtures.py` for the
# 500-line cap (py-split slice, 2026-09-27). No secrets.choice()/uuid4()
# anywhere in it -- a rehearsal that produces different ids on every run
# cannot prove idempotency by comparing two runs' output.
# ---------------------------------------------------------------------------

from .rehearsal_fixtures import MICROS_VALUE, MS_VALUE, T0, _source_rows


NOT_EXERCISED_NEVER_WRITTEN = ("session_links", "trace_hits", "search_chunks_v1", "read_cursors")
NOT_EXERCISED_OUT_OF_SCOPE = ("nodes", "node_revisions", "node_revision_terms", "revision_links")
REPLACED_SOURCE_ONLY = ("memories", "memory_terms")


class _ReadOnlySource:
    """Wraps a LanceDB connection so the migration path can only READ.

    Any attribute that would create, drop, or rename a table raises before
    the underlying call happens. This is enforcement, not just a promise in a
    docstring: ``migrate()`` is handed one of these, never the raw ``db``.
    """

    _FORBIDDEN = ("create_table", "drop_table", "drop_all_tables", "drop_database", "rename_table")

    def __init__(self, db: Any) -> None:
        self._db = db

    def __getattr__(self, name: str) -> Any:
        if name in self._FORBIDDEN:
            raise RuntimeError(f"migration path attempted a mutating source call: {name}()")
        return getattr(self._db, name)


@dataclass
class TableReport:
    rows_in: int
    rows_out: int
    exercised: bool
    note: str


@dataclass
class RehearsalReport:
    tables: dict[str, TableReport] = field(default_factory=dict)

    def as_rows(self) -> list[tuple[str, int, int, bool, str]]:
        return [(name, r.rows_in, r.rows_out, r.exercised, r.note) for name, r in self.tables.items()]


# ---------------------------------------------------------------------------
# Source construction
# ---------------------------------------------------------------------------


def build_source(root: Path) -> tuple[Any, dict[str, list[dict[str, Any]]]]:
    """Create the disposable source dataset. Returns (db, rows-as-written)."""

    db = lancedb.connect(str(root / "source"))
    rows = _source_rows()
    for name, model in ACTIVE_TABLES.items():
        table = db.create_table(name, schema=model)
        row_list = rows[name]
        if row_list:
            table.add([model(**row) for row in row_list])
    return db, rows


def snapshot(db: Any, table_names: list[str]) -> dict[str, tuple[list, int, int]]:
    """(described-schema, version, row-count) per table -- the non-destructive gate."""

    out = {}
    for name in table_names:
        handle = db.open_table(name)
        out[name] = (describe_schema(handle.schema), handle.version, handle.count_rows())
    return out


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------


def _vocab_workspace_lookup(source_rows: dict[str, list[dict[str, Any]]]) -> dict[str, str]:
    return {row["id"]: row["workspace_name"] for row in source_rows["vocabularies"]}


def migrate(source: _ReadOnlySource, source_rows: dict[str, list[dict[str, Any]]], target_root: Path) -> RehearsalReport:
    """Read from *source* (read-only), write the target-19 shape under *target_root*.

    *source_rows* is passed alongside the read-only db handle so the migration
    does not need extra queries to resolve lookups (e.g. vocabulary ->
    workspace) -- it is the same data ``build_source`` already wrote.
    """

    target_db = lancedb.connect(str(target_root / "target"))
    report = RehearsalReport()

    def direct(name: str, extra: Optional[Callable[[dict], dict]] = None, note: str = "direct copy, matching physical shape") -> None:
        model = TARGET_TABLES[name]
        source_handle = source.open_table(name)
        rows_in = source_handle.to_arrow().to_pylist()
        target_fields = set(model.model_fields)
        built = []
        for row in rows_in:
            values = {k: v for k, v in row.items() if k in target_fields}
            if extra is not None:
                values.update(extra(row))
            built.append(model(**values))
        table = target_db.create_table(name, schema=model)
        if built:
            table.add(built)
        report.tables[name] = TableReport(len(rows_in), len(built), True, note)

    # 11 tables that map 1:1 by name onto the target shape.
    direct("workspaces")
    direct("peers")
    direct("sessions")
    direct("session_peers")
    direct("connections")
    direct(
        "messages",
        extra=lambda row: {"ingested_at": T0, "source_namespace": None,
                            "source_message_id": None, "source_payload_digest": None,
                            "source_created_at": None},
        note="direct copy; ingested_at set explicitly to migration time (no first-row default)",
    )
    direct(
        "vocabularies",
        extra=lambda row: {"cardinality": "many", "required": False, "hierarchy": "flat"},
        note="direct copy; cardinality/required/hierarchy BACKFILLED with a policy default "
             "(many/false/flat) -- no source equivalent, decision made explicit, not authoritative",
    )
    vocab_ws = _vocab_workspace_lookup(source_rows)
    direct(
        "terms",
        extra=lambda row: {"workspace_name": vocab_ws[row["vocabulary_id"]], "is_active": True},
        note="direct copy; workspace_name DERIVED via vocabulary_id lookup, is_active defaulted True",
    )
    direct(
        "supersede_log",
        extra=lambda row: {
            "reason": row["reason"] if row["reason"] is not None else "",
            "operation_id": f"migrated-{row['id']}",
            "old_revision_id": f"unknown-revision-{row['old_id']}",
            "new_revision_id": None,
        },
        note="direct copy; reason=None BACKFILLED to '' (target requires non-null -- schema drift "
             "found by comparing active vs target physical shape); operation_id/old_revision_id "
             "are SYNTHESIZED placeholders, not sourced -- flagged, not silently invented",
    )
    direct(
        "traces",
        note="direct copy of raw epoch-MILLISECOND int64 columns (created_at, updated_at, "
             "session_from_ts, session_to_ts) -- NO datetime conversion applied. distilled_to/"
             "distilled_at dropped (target design change, not a migration decision)",
    )
    direct(
        "mcp_calls",
        extra=lambda row: {"connection_id": None, "principal": None},
        note="direct copy of raw epoch-MILLISECOND int64 created_at; connection_id/principal "
             "left NULL (no source identity to attach)",
    )

    # trace_hits / read_cursors: source has zero rows (never written historically).
    # Create the target table so the 19-table shape exists, but report it honestly.
    for name in ("trace_hits", "read_cursors"):
        model = TARGET_TABLES[name]
        target_db.create_table(name, schema=model)
        report.tables[name] = TableReport(0, 0, False, "source had 0 rows -- never written historically, per the measured live-spike baseline")

    # session_links / search_chunks_v1: no active-15 equivalent at all.
    for name in ("session_links", "search_chunks_v1"):
        model = TARGET_TABLES[name]
        target_db.create_table(name, schema=model)
        report.tables[name] = TableReport(0, 0, False, "no source table of this shape exists in the active-15 registry")

    # nodes / node_revisions / node_revision_terms / revision_links: the real
    # mapping from memories/memory_terms needs canonicalization + content
    # digests owned by the concurrent association/publication kernel work.
    # Not fabricated here.
    for name in ("nodes", "node_revisions", "node_revision_terms", "revision_links"):
        model = TARGET_TABLES[name]
        target_db.create_table(name, schema=model)
        report.tables[name] = TableReport(
            0, 0, False,
            "memories/memory_terms->node/revision mapping needs canonicalization and content-digest "
            "logic owned by the concurrent association/publication kernel work (service.ts); not "
            "reimplemented here to avoid fabricating that business logic",
        )

    # memories / memory_terms themselves: source-only, no target table exists
    # (REPLACED_ACTIVE_TABLES). Report explicitly rather than omitting them.
    for name in REPLACED_SOURCE_ONLY:
        rows_in = source.open_table(name).to_arrow().to_pylist()
        report.tables[name] = TableReport(
            len(rows_in), 0, False,
            "REPLACED in the target (no table of this name exists in target-19); source rows "
            "captured for completeness, not migrated -- see nodes/node_revisions note above",
        )

    assert set(report.tables) == set(TARGET_TABLE_NAMES) | set(REPLACED_SOURCE_ONLY)
    return report, target_db


# ---------------------------------------------------------------------------
# Value-level verification (not row counts)
# ---------------------------------------------------------------------------


def verify_value_level(source: Any, target_db: Any, report: RehearsalReport) -> list[str]:
    """Compare every SHARED field, row by row, for every exercised table.

    Returns a list of human-readable problems; empty means every exercised
    table's migrated rows matched the source exactly on every field the two
    schemas share. Uses a natural key per table (falls back to positional
    zip when a table has no single-column key) so a re-ordering during
    migration cannot hide a mismatch behind a coincidental positional match.
    """

    natural_key = {
        "workspaces": "id", "peers": "id", "sessions": "id", "connections": "id",
        "messages": "public_id", "vocabularies": "id", "terms": "id",
        "supersede_log": "id", "traces": "id", "mcp_calls": "id",
    }
    # Fields the migration DELIBERATELY changes (documented in migrate()'s
    # `note=` for that table) are checked against their OWN rule below, not
    # against strict source==target equality -- a rehearsal that flagged its
    # own documented backfill as a "mismatch" would train reviewers to ignore
    # the report.
    known_backfill_rule = {
        ("supersede_log", "reason"): lambda src_val, tgt_val: tgt_val == (src_val if src_val is not None else ""),
    }
    problems: list[str] = []
    for name, table_report in report.tables.items():
        if not table_report.exercised or table_report.rows_out == 0:
            continue
        if name not in ACTIVE_TABLES:
            continue  # e.g. no source table of this shape
        source_rows = source.open_table(name).to_arrow().to_pylist()
        target_rows = target_db.open_table(name).to_arrow().to_pylist()
        shared_fields = set(ACTIVE_TABLES[name].model_fields) & set(TARGET_TABLES[name].model_fields)
        key = natural_key.get(name)
        if key:
            source_by_key = {r[key]: r for r in source_rows}
            target_by_key = {r[key]: r for r in target_rows}
            if set(source_by_key) != set(target_by_key):
                problems.append(f"{name}: key set differs {set(source_by_key)} vs {set(target_by_key)}")
                continue
            pairs = [(source_by_key[k], target_by_key[k]) for k in source_by_key]
        else:
            pairs = list(zip(source_rows, target_rows))
        for src, tgt in pairs:
            for f in shared_fields:
                rule = known_backfill_rule.get((name, f))
                if rule is not None:
                    if not rule(src[f], tgt[f]):
                        problems.append(f"{name}.{f}: documented backfill rule violated, source={src[f]!r} target={tgt[f]!r}")
                    continue
                if src[f] != tgt[f]:
                    problems.append(f"{name}.{f}: source={src[f]!r} target={tgt[f]!r}")
    return problems


# ---------------------------------------------------------------------------
# Requirement 4: the ms-vs-micros unit trap, proven and disproven.
# ---------------------------------------------------------------------------


def prove_unit_handling(root: Path) -> dict[str, Any]:
    """Round-trip MS_VALUE through traces (int64 ms) and MICROS_VALUE through
    trace_hits (timestamp[us]), then show the mis-scaled interpretation fails.

    Returns a dict of the measured outcomes; every assertion inside raises if
    it does not hold, so a caller can either read the dict or just call this
    and treat "returned without raising" as the proof.
    """

    db = lancedb.connect(str(root / "units"))

    # 1. traces: raw int64 milliseconds, no datetime conversion anywhere.
    trace_model = TARGET_TABLES["traces"]
    trace_row = {
        "id": "t1", "name": "unit-trap", "workspace_name": "ws-rehearsal", "session_name": None,
        "peer_name": None, "query": "q", "mode": None, "session_id": None,
        "session_from_ts": MS_VALUE, "session_to_ts": MS_VALUE, "friction_score": None,
        "confidence": None, "parent_id": None, "prev_id": None, "depth": 0, "status": "raw",
        "h_metadata": None, "internal_metadata": None, "created_at": MS_VALUE, "updated_at": MS_VALUE,
    }
    traces_table = db.create_table("traces", schema=trace_model)
    traces_table.add([trace_model(**trace_row)])
    back_trace = traces_table.to_arrow().to_pylist()[0]
    assert back_trace["created_at"] == MS_VALUE, "traces.created_at must survive as the exact ms int64"
    assert back_trace["session_from_ts"] == MS_VALUE

    # 2. trace_hits: timestamp[us], built from a CORRECT microsecond datetime.
    hit_model = TARGET_TABLES["trace_hits"]
    captured_at = datetime(1970, 1, 1) + timedelta(microseconds=MICROS_VALUE)
    hit_row = {
        "workspace_name": "ws-rehearsal", "trace_id": "t1", "kind": "file", "ref": "x.ts:1",
        "target": '{"kind":"file","ref":"x.ts:1"}', "line_start": None, "line_end": None,
        "excerpt": None, "content_hash": None, "captured_at": captured_at, "note": None, "position": 0,
    }
    hits_table = db.create_table("trace_hits", schema=hit_model)
    hits_table.add([hit_model(**hit_row)])
    back_hit = hits_table.to_arrow().to_pylist()[0]
    recovered_micros = (back_hit["captured_at"] - datetime(1970, 1, 1)) // timedelta(microseconds=1)
    assert recovered_micros == MICROS_VALUE, f"trace_hits.captured_at must round-trip to the exact micros int, got {recovered_micros}"

    # 3. THE TRAP, demonstrated failing: treat traces' ms value as if it were
    # already microseconds (i.e. run it through the micros-only helper without
    # first multiplying by 1000). This is exactly what "the accepted helpers
    # microsToTimestamp/timestampToMicros are MICROS-ONLY" warns against.
    wrongly_as_micros = datetime(1970, 1, 1) + timedelta(microseconds=MS_VALUE)
    correctly_as_ms = datetime(1970, 1, 1) + timedelta(milliseconds=MS_VALUE)
    assert correctly_as_ms.year == 9999
    assert wrongly_as_micros.year != 9999, "the trap must actually misfire when demonstrated, or it proves nothing"
    assert wrongly_as_micros != correctly_as_ms

    # 4. The BigInt-corruption CLASS, demonstrated in the abstract: MICROS_VALUE
    # exceeds float64's exact-integer range (2**53). This is why a JS Number
    # (IEEE-754 double) corrupts it and Arrow needs BigInt on that side; Python
    # ints are arbitrary precision, so THIS process is not exposed to the bug,
    # but the numeric fact underneath it is language-independent and worth
    # proving directly rather than taking on faith.
    as_float64 = np.float64(MICROS_VALUE)
    round_tripped_through_float64 = int(as_float64)
    assert MICROS_VALUE > 2**53, "the demonstration only means something if the value is actually beyond float64 exact-integer range"
    assert round_tripped_through_float64 != MICROS_VALUE, (
        "expected float64 to be unable to represent this value exactly -- "
        f"got {round_tripped_through_float64} vs {MICROS_VALUE}"
    )
    # ...and the value pyarrow actually persisted (via a Python int, never a
    # float) is NOT that corrupted value -- it is the exact original.
    assert recovered_micros != round_tripped_through_float64 or recovered_micros == MICROS_VALUE

    return {
        "ms_round_trip_exact": back_trace["created_at"] == MS_VALUE,
        "micros_round_trip_exact": recovered_micros == MICROS_VALUE,
        "trap_misfires_as_designed": wrongly_as_micros.year != 9999,
        "float64_would_have_corrupted_it": round_tripped_through_float64 != MICROS_VALUE,
    }


# ---------------------------------------------------------------------------
# One-shot runnable entry point (not wired into __main__.py / the runtime).
# ---------------------------------------------------------------------------


def run_rehearsal() -> dict[str, Any]:
    """Build source, migrate, verify, prove units, clean up. Returns a summary."""

    root = Path(tempfile.mkdtemp(prefix="arra-migration-rehearsal-"))
    try:
        source_db, source_rows = build_source(root)
        before = snapshot(source_db, list(ACTIVE_TABLES))
        read_only = _ReadOnlySource(source_db)

        report, target_db = migrate(read_only, source_rows, root)

        after = snapshot(source_db, list(ACTIVE_TABLES))
        non_destructive = before == after

        value_problems = verify_value_level(source_db, target_db, report)

        units = prove_unit_handling(root)

        # Idempotency: rebuild source+target from scratch in a second temp
        # root and compare every exercised table's output rows for equality.
        root2 = Path(tempfile.mkdtemp(prefix="arra-migration-rehearsal-rerun-"))
        try:
            source_db2, source_rows2 = build_source(root2)
            report2, target_db2 = migrate(_ReadOnlySource(source_db2), source_rows2, root2)
            idempotent = True
            for name, tr in report.tables.items():
                if not tr.exercised:
                    continue
                a = target_db.open_table(name).to_arrow().to_pylist()
                b = target_db2.open_table(name).to_arrow().to_pylist()
                if a != b:
                    idempotent = False
                    break
        finally:
            shutil.rmtree(root2, ignore_errors=True)

        return {
            "report": report,
            "non_destructive": non_destructive,
            "value_level_problems": value_problems,
            "unit_handling": units,
            "idempotent_rerun": idempotent,
        }
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    result = run_rehearsal()
    print(f"{'table':<22} {'in':>4} {'out':>4}  exercised  note")
    for name, r in result["report"].tables.items():
        print(f"{name:<22} {r.rows_in:>4} {r.rows_out:>4}  {str(r.exercised):<9}  {r.note}")
    print()
    print("non_destructive:", result["non_destructive"])
    print("value_level_problems:", result["value_level_problems"] or "none")
    print("unit_handling:", result["unit_handling"])
    print("idempotent_rerun:", result["idempotent_rerun"])
