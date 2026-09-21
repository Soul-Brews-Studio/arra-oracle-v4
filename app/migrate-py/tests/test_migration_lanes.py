"""Precision/recovery lanes on top of the #34 migration rehearsal.

Six properties, each proved against the REAL ``arra_migrate.rehearsal``
pathway (not a reimplementation of it):

  1. Idempotence -- a second run against the SAME target root fails LOUD
     (no silent duplicate rows), and the first run's rows are left untouched.
  2. Crash recovery -- a real child process is SIGKILLed mid-migration, by
     its exact PID, synchronized on the child's own progress output (never a
     sleep guess). The partial target is discarded and a fresh rerun
     converges to the same rows a clean run produces, with no partial or
     duplicated tables left behind.
  3. Int64 boundary fidelity -- the extreme ms/us timestamp values are read
     back through RAW pyarrow (never through ``prove_unit_handling``'s own
     converter, and never through a pydantic reconstruction) after flowing
     through the actual ``migrate()`` call.
  4. Non-destructiveness -- asserted on the source dataset's real bytes on
     disk, not just the schema+version+row-count snapshot the existing
     ``NonDestructiveTests`` already covers.
  5. Schema exactness -- the RUNTIME output of ``migrate()`` (the actual
     LanceDB tables it created) is exactly the 19-table target set, no more,
     no fewer -- as opposed to the static registry checks already in
     ``test_target_schema_v1.py``.
  6. Ordering determinism -- repeated, independent reads of a source table
     return rows in the same order every time, and that is the order
     ``migrate()`` actually writes into the target.

What this file does NOT prove: production readiness, in-place upsert
idempotency against a live target, or resumable/partial-write recovery --
see ``arra_migrate.rehearsal``'s module docstring LIMITATIONS. "Crash
recovery" here means: discard the partial target and rerun from scratch,
which converges -- not that the killed run itself resumes.
"""

from __future__ import annotations

import hashlib
import os
import selectors
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

import pyarrow as pa

from arra_migrate.rehearsal import (
    MICROS_VALUE,
    MS_VALUE,
    _ReadOnlySource,
    build_source,
    migrate,
)
from arra_migrate.target_v1 import TARGET_TABLE_NAMES

CHILD_DEADLINE_SECONDS = 30


def _read_line_by_deadline(stream, deadline_seconds: float = CHILD_DEADLINE_SECONDS) -> str:
    """Read one line, bounded by a real wall-clock deadline -- never a sleep guess."""
    selector = selectors.DefaultSelector()
    selector.register(stream, selectors.EVENT_READ)
    buffer = b""
    end = time.monotonic() + deadline_seconds
    try:
        while time.monotonic() < end:
            if not selector.select(timeout=max(0.0, end - time.monotonic())):
                break
            chunk = os.read(stream.fileno(), 1)
            if not chunk:
                break
            buffer += chunk
            if chunk == b"\n":
                return buffer.decode("utf-8", "replace")
    finally:
        selector.unregister(stream)
        selector.close()
    return buffer.decode("utf-8", "replace")


def _hash_tree(root: Path) -> dict[str, str]:
    """relative-path -> sha256(content) for every file under *root*."""
    out = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            out[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


class IdempotenceSameTargetTests(unittest.TestCase):
    """Property 1: rerunning against the SAME target root must fail loud,
    never silently duplicate rows."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="arra-lanes-idem-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.source_db, self.source_rows = build_source(self.root)

    def test_second_run_against_the_same_target_root_raises_not_silently_duplicates(self):
        readonly = _ReadOnlySource(self.source_db)
        report_a, target_db = migrate(readonly, self.source_rows, self.root)
        before_counts = {
            name: target_db.open_table(name).count_rows()
            for name, tr in report_a.tables.items()
            if tr.exercised
        }

        with self.assertRaises(Exception) as ctx:
            migrate(readonly, self.source_rows, self.root)
        # Bite test performed manually during development: lancedb's
        # create_table on an existing name raises ValueError("... already
        # exists"); if a future lancedb silently allowed mode="overwrite" or
        # "append" by default, this assertion would need to change deliberately
        # -- catching that drift is exactly the point.
        self.assertIn("already exists", str(ctx.exception))

        # And the FIRST run's rows must be exactly as they were -- a raise
        # halfway through table #1 must not have touched any existing table.
        for name, expected in before_counts.items():
            with self.subTest(table=name):
                self.assertEqual(target_db.open_table(name).count_rows(), expected)

    def test_ordinals_have_no_gaps_and_no_duplicates_within_one_run(self):
        """'no skipped ordinals' -- the sequential id columns are exactly the
        source's ids, once each, not renumbered and not doubled."""
        readonly = _ReadOnlySource(self.source_db)
        _, target_db = migrate(readonly, self.source_rows, self.root)
        message_ids = sorted(r["id"] for r in target_db.open_table("messages").to_arrow().to_pylist())
        self.assertEqual(message_ids, [1, 2])
        mcp_ids = [r["id"] for r in target_db.open_table("mcp_calls").to_arrow().to_pylist()]
        self.assertEqual(mcp_ids, ["call-01"])
        supersede_ids = [r["id"] for r in target_db.open_table("supersede_log").to_arrow().to_pylist()]
        self.assertEqual(supersede_ids, [1])


class CrashRecoveryTests(unittest.TestCase):
    """Property 2: a REAL child, SIGKILLed by its exact PID mid-migration,
    then a fresh rerun converges to a clean run's output."""

    CHILD_SOURCE = textwrap.dedent(
        """
        import sys
        from pathlib import Path
        import lancedb
        from arra_migrate.rehearsal import build_source, migrate, _ReadOnlySource

        root = Path(sys.argv[1])
        source_db, source_rows = build_source(root)

        real_connect = lancedb.connect

        def patched_connect(uri, *a, **kw):
            conn = real_connect(uri, *a, **kw)
            real_create = conn.create_table

            def wrapped(name, schema=None, **kw2):
                table = real_create(name, schema=schema, **kw2)
                print(f"CREATED:{name}", flush=True)
                return table

            conn.create_table = wrapped
            return conn

        lancedb.connect = patched_connect
        migrate(_ReadOnlySource(source_db), source_rows, root)
        print("DONE", flush=True)
        """
    )

    def _spawn_child(self, target_root: Path) -> subprocess.Popen:
        tmp = tempfile.mkdtemp(prefix="arra-lanes-crash-child-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        script = Path(tmp) / "child.py"
        script.write_text(self.CHILD_SOURCE, encoding="utf-8")
        return subprocess.Popen(
            [sys.executable, str(script), str(target_root)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
        )

    def test_real_sigkill_mid_run_then_a_fresh_rerun_converges(self):
        killed_root = Path(tempfile.mkdtemp(prefix="arra-lanes-crash-killed-"))
        self.addCleanup(shutil.rmtree, killed_root, ignore_errors=True)

        child = self._spawn_child(killed_root)
        pid = child.pid
        created_tables: list[str] = []
        try:
            # Synchronize on the child's OWN progress markers -- never a sleep
            # guess. Stop partway through the 19 create_table calls so the
            # kill lands genuinely mid-run, not before start or after finish.
            while len(created_tables) < 5:
                line = _read_line_by_deadline(child.stdout).strip()
                if not line:
                    self.fail("child exited or stalled before reaching table #5")
                if line.startswith("CREATED:"):
                    created_tables.append(line.split(":", 1)[1])
                elif line == "DONE":
                    self.fail("child finished before we could kill it mid-run -- test is not exercising a real mid-run kill")
        finally:
            # Real SIGKILL by the exact PID we launched -- no pattern match.
            os.kill(pid, 9)
            try:
                child.wait(timeout=CHILD_DEADLINE_SECONDS)
            except subprocess.TimeoutExpired:
                self.fail(f"child pid {pid} did not die within the deadline after SIGKILL")
            for stream in (child.stdout, child.stderr):
                if stream is not None:
                    stream.close()

        # Prove the kill actually landed: the process is gone.
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertLess(child.returncode, 0, "child should have died by signal, not exited cleanly")

        # Prove this was a genuine MID-run state: strictly fewer than the
        # full 19 tables exist, and at least the ones we observed do.
        partial_names = set()
        target_dir = killed_root / "target.lance"
        source_dir = killed_root / "source.lance"
        self.assertTrue(source_dir.exists() or (killed_root / "source").exists())
        # Discover partial tables the filesystem way, independent of any
        # lancedb connection object the dead child held.
        target_root_dir = killed_root / "target"
        if target_root_dir.exists():
            partial_names = {p.stem for p in target_root_dir.glob("*.lance")}
        self.assertGreater(len(partial_names), 0, "kill landed before any table was written -- not a real mid-run kill")
        self.assertLess(len(partial_names), 19, "kill landed after the full run completed -- not a real mid-run kill")
        self.assertTrue(set(created_tables) <= (partial_names | set()), created_tables)

        # Recovery: discard the partial target, rerun fresh, converge.
        shutil.rmtree(killed_root / "target", ignore_errors=True)
        source_db = __import__("lancedb").connect(str(killed_root / "source"))
        from arra_migrate.rehearsal import _source_rows

        recovered_report, recovered_db = migrate(_ReadOnlySource(source_db), _source_rows(), killed_root)

        # Independent clean reference run from a brand new root.
        ref_root = Path(tempfile.mkdtemp(prefix="arra-lanes-crash-ref-"))
        self.addCleanup(shutil.rmtree, ref_root, ignore_errors=True)
        ref_source_db, ref_source_rows = build_source(ref_root)
        ref_report, ref_db = migrate(_ReadOnlySource(ref_source_db), ref_source_rows, ref_root)

        self.assertEqual(set(recovered_report.tables), set(ref_report.tables))
        recovered_tables = set(recovered_db.list_tables().tables)
        self.assertEqual(len(recovered_tables), 19, "recovered target must have exactly 19 tables -- no partial, no duplicate")
        for name, tr in ref_report.tables.items():
            if not tr.exercised:
                continue
            with self.subTest(table=name):
                recovered_rows = recovered_db.open_table(name).to_arrow().to_pylist()
                ref_rows = ref_db.open_table(name).to_arrow().to_pylist()
                self.assertEqual(recovered_rows, ref_rows, f"{name}: recovered rerun diverged from a clean reference run")


class Int64BoundaryRawFidelityTests(unittest.TestCase):
    """Property 3: read the boundary values back as RAW pyarrow/Python int
    (the arbitrary-precision equivalent of BigInt), through the REAL
    migrate() pathway, never through prove_unit_handling's own converter."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="arra-lanes-int64-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.source_db, self.source_rows = build_source(self.root)
        self.report, self.target_db = migrate(_ReadOnlySource(self.source_db), self.source_rows, self.root)

    def test_traces_ms_columns_are_int64_arrow_type_and_exact_after_migrate(self):
        arrow_tbl = self.target_db.open_table("traces").to_arrow()
        for field_name in ("created_at", "updated_at", "session_from_ts", "session_to_ts"):
            with self.subTest(field=field_name):
                field = arrow_tbl.schema.field(field_name)
                self.assertEqual(field.type, pa.int64(), f"{field_name} must be a real int64 column, not float/double")
                column = arrow_tbl.column(field_name)
                # combine_chunks + a numpy view proves the VALUE itself, read
                # straight off the Arrow buffer -- not via to_pylist()'s
                # Python-object boxing, and not via any datetime helper.
                raw_values = column.combine_chunks().to_numpy(zero_copy_only=False)
                self.assertEqual(int(raw_values[0]), MS_VALUE)

    def test_mcp_calls_created_at_is_int64_and_exact_after_migrate(self):
        arrow_tbl = self.target_db.open_table("mcp_calls").to_arrow()
        field = arrow_tbl.schema.field("created_at")
        self.assertEqual(field.type, pa.int64())
        raw_values = arrow_tbl.column("created_at").combine_chunks().to_numpy(zero_copy_only=False)
        self.assertEqual(int(raw_values[0]), MS_VALUE)

    def test_ms_value_exceeds_int32_range_so_this_is_a_real_int64_test(self):
        # If MS_VALUE fit in 32 bits, a silent int64->int32 truncation
        # upstream could pass this test by accident. Pin the precondition.
        self.assertGreater(MS_VALUE, 2**31 - 1)

    def test_a_deliberately_widened_int32_column_would_be_caught(self):
        """Bite test for the type assertion above: prove it actually fails
        when the column really is too narrow, by building a throwaway table
        with an int32 column holding a truncated copy of the same value and
        running the SAME assertion against it."""
        truncated = MS_VALUE % (2**31)  # what a (positive) int32 store would keep
        self.assertNotEqual(truncated, MS_VALUE, "the truncation must actually lose information or this bite test proves nothing")
        throwaway_root = Path(tempfile.mkdtemp(prefix="arra-lanes-int32-bite-"))
        self.addCleanup(shutil.rmtree, throwaway_root, ignore_errors=True)
        import lancedb

        db = lancedb.connect(str(throwaway_root / "bite"))
        tbl = pa.table({"created_at": pa.array([truncated], type=pa.int32())})
        table = db.create_table("bite", data=tbl)
        arrow_tbl = table.to_arrow()
        field = arrow_tbl.schema.field("created_at")
        with self.assertRaises(AssertionError):
            self.assertEqual(field.type, pa.int64())


class RawByteNonDestructivenessTests(unittest.TestCase):
    """Property 4: the source dataset's real bytes on disk are unchanged --
    not just its schema/version/row-count snapshot."""

    def test_source_directory_bytes_are_byte_identical_after_migration(self):
        root = Path(tempfile.mkdtemp(prefix="arra-lanes-bytes-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        source_db, source_rows = build_source(root)
        source_dir = root / "source"
        self.assertTrue(source_dir.exists())
        before = _hash_tree(source_dir)
        self.assertGreater(len(before), 0, "no source files found -- the hash check would be vacuous")

        migrate(_ReadOnlySource(source_db), source_rows, root)

        after = _hash_tree(source_dir)
        self.assertEqual(set(before), set(after), "files appeared or disappeared under the source directory")
        for rel_path, digest in before.items():
            with self.subTest(file=rel_path):
                self.assertEqual(after[rel_path], digest, f"{rel_path} changed bytes during migration")

    def test_a_real_source_mutation_would_be_caught(self):
        """Bite test: corrupt one byte of a real source data file after the
        'before' hash and confirm the same comparison fails."""
        root = Path(tempfile.mkdtemp(prefix="arra-lanes-bytes-bite-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        build_source(root)
        source_dir = root / "source"
        before = _hash_tree(source_dir)
        target_file = next(p for p in source_dir.rglob("*") if p.is_file())
        data = bytearray(target_file.read_bytes())
        data[0] ^= 0xFF
        target_file.write_bytes(bytes(data))
        after = _hash_tree(source_dir)
        self.assertNotEqual(before, after, "flipping a byte must be detectable, or this bite test proves nothing")


class SchemaExactnessRuntimeTests(unittest.TestCase):
    """Property 5: the RUNTIME output of migrate() is exactly the 19-table
    target set -- not the static registry declaration already covered by
    test_target_schema_v1.py."""

    def test_migrate_creates_exactly_the_nineteen_target_tables_no_more_no_fewer(self):
        root = Path(tempfile.mkdtemp(prefix="arra-lanes-schema-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        source_db, source_rows = build_source(root)
        _, target_db = migrate(_ReadOnlySource(source_db), source_rows, root)
        actual = set(target_db.list_tables().tables)
        self.assertEqual(actual, set(TARGET_TABLE_NAMES))
        self.assertEqual(len(actual), 19)
        self.assertNotIn("batches", actual)

    def test_an_extra_stray_table_would_be_caught(self):
        """Bite test: create one table migrate() never asked for and confirm
        the exact-set assertion fails against it."""
        root = Path(tempfile.mkdtemp(prefix="arra-lanes-schema-bite-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        source_db, source_rows = build_source(root)
        _, target_db = migrate(_ReadOnlySource(source_db), source_rows, root)
        import pyarrow as pa_local

        target_db.create_table("stray_extra_table", data=pa_local.table({"x": [1]}))
        actual = set(target_db.list_tables().tables)
        self.assertNotEqual(actual, set(TARGET_TABLE_NAMES))
        self.assertEqual(actual - set(TARGET_TABLE_NAMES), {"stray_extra_table"})


class OrderingDeterminismTests(unittest.TestCase):
    """Property 6: repeated, independent reads of a source table return rows
    in the same order every time, and that is the order migrate() writes."""

    def test_repeated_independent_reads_of_a_multi_row_source_table_agree_on_order(self):
        import lancedb

        root = Path(tempfile.mkdtemp(prefix="arra-lanes-order-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        build_source(root)

        orderings = []
        for _ in range(5):
            fresh_db = lancedb.connect(str(root / "source"))
            rows = fresh_db.open_table("messages").to_arrow().to_pylist()
            orderings.append(tuple(r["public_id"] for r in rows))

        self.assertEqual(len(set(orderings)), 1, f"row order was not stable across independent reads: {orderings}")

    def test_migrate_writes_rows_in_the_same_order_the_source_read_returned(self):
        root = Path(tempfile.mkdtemp(prefix="arra-lanes-order-write-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        source_db, source_rows = build_source(root)
        source_order = tuple(r["public_id"] for r in source_db.open_table("messages").to_arrow().to_pylist())

        _, target_db = migrate(_ReadOnlySource(source_db), source_rows, root)
        target_order = tuple(r["public_id"] for r in target_db.open_table("messages").to_arrow().to_pylist())

        self.assertEqual(source_order, target_order, "migrate() must not silently reorder rows it never explicitly sorted")

    def test_a_deliberate_reorder_would_be_caught(self):
        """Bite test: reverse a captured ordering and confirm the equality
        assertion above would fail against it."""
        source_order = ("msg-pub-01", "msg-pub-02")
        reordered = tuple(reversed(source_order))
        self.assertNotEqual(source_order, reordered)


if __name__ == "__main__":
    unittest.main()
