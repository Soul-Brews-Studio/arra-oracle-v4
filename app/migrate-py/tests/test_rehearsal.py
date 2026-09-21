"""Migration rehearsal gates. Issue #34.

What these tests prove: a disposable active-15 source can be migrated into
the target-19 physical shape with a value-level (not row-count) comparison,
the source is left untouched, the run is idempotent, and the traces
ms-vs-trace_hits us split survives a round trip exactly while the mis-scaled
interpretation of it visibly fails.

What they do NOT prove: production readiness, or a correct memories ->
node/revision business transform. See ``arra_migrate.rehearsal``'s module
docstring for the full list of what is out of scope.
"""

import shutil
import tempfile
import unittest
from pathlib import Path

from arra_migrate.models import TABLES as ACTIVE_TABLES
from arra_migrate.rehearsal import (
    MICROS_VALUE,
    MS_VALUE,
    NOT_EXERCISED_NEVER_WRITTEN,
    NOT_EXERCISED_OUT_OF_SCOPE,
    REPLACED_SOURCE_ONLY,
    _ReadOnlySource,
    build_source,
    migrate,
    prove_unit_handling,
    run_rehearsal,
    snapshot,
    verify_value_level,
)
from arra_migrate.target_v1 import TARGET_TABLE_NAMES


class SourceConstructionTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="arra-rehearsal-test-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_source_covers_all_fifteen_active_tables(self):
        db, rows = build_source(self.root)
        self.assertEqual(set(rows), set(ACTIVE_TABLES))
        for name in ACTIVE_TABLES:
            handle = db.open_table(name)
            self.assertEqual(handle.count_rows(), len(rows[name]))

    def test_trace_hits_and_read_cursors_start_empty(self):
        # Matches the measured live-spike baseline: these were never written.
        db, rows = build_source(self.root)
        self.assertEqual(rows["trace_hits"], [])
        self.assertEqual(rows["read_cursors"], [])


class MigrationReportTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="arra-rehearsal-test-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.source_db, self.source_rows = build_source(self.root)

    def test_report_covers_every_target_table_plus_the_two_replaced_source_tables(self):
        report, _ = migrate(_ReadOnlySource(self.source_db), self.source_rows, self.root)
        self.assertEqual(set(report.tables), set(TARGET_TABLE_NAMES) | set(REPLACED_SOURCE_ONLY))

    def test_never_written_tables_are_reported_not_exercised_not_silently_zero(self):
        report, _ = migrate(_ReadOnlySource(self.source_db), self.source_rows, self.root)
        for name in NOT_EXERCISED_NEVER_WRITTEN:
            with self.subTest(table=name):
                self.assertFalse(report.tables[name].exercised)
                self.assertEqual(report.tables[name].rows_out, 0)
                self.assertTrue(report.tables[name].note)  # not a bare zero, a reason

    def test_association_kernel_tables_are_reported_not_exercised_with_a_reason(self):
        report, _ = migrate(_ReadOnlySource(self.source_db), self.source_rows, self.root)
        for name in NOT_EXERCISED_OUT_OF_SCOPE:
            with self.subTest(table=name):
                self.assertFalse(report.tables[name].exercised)
                self.assertIn("service.ts", report.tables[name].note)

    def test_eleven_tables_are_actually_exercised_with_rows(self):
        report, _ = migrate(_ReadOnlySource(self.source_db), self.source_rows, self.root)
        exercised = [n for n, r in report.tables.items() if r.exercised]
        self.assertEqual(len(exercised), 11)
        for name in exercised:
            self.assertGreater(report.tables[name].rows_out, 0)

    def test_migration_path_cannot_mutate_the_source(self):
        readonly = _ReadOnlySource(self.source_db)
        with self.assertRaises(RuntimeError):
            readonly.create_table("sneaky", schema=ACTIVE_TABLES["workspaces"])
        with self.assertRaises(RuntimeError):
            readonly.drop_table("workspaces")


class NonDestructiveTests(unittest.TestCase):
    def test_source_schema_version_and_row_counts_are_unchanged_after_migration(self):
        root = Path(tempfile.mkdtemp(prefix="arra-rehearsal-test-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        source_db, source_rows = build_source(root)
        before = snapshot(source_db, list(ACTIVE_TABLES))
        migrate(_ReadOnlySource(source_db), source_rows, root)
        after = snapshot(source_db, list(ACTIVE_TABLES))
        self.assertEqual(before, after)


class ValueLevelVerificationTests(unittest.TestCase):
    def test_migrated_rows_match_the_source_field_for_field(self):
        root = Path(tempfile.mkdtemp(prefix="arra-rehearsal-test-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        source_db, source_rows = build_source(root)
        report, target_db = migrate(_ReadOnlySource(source_db), source_rows, root)
        problems = verify_value_level(source_db, target_db, report)
        self.assertEqual(problems, [])

    def test_thai_text_and_extreme_ms_values_survive_the_migration(self):
        root = Path(tempfile.mkdtemp(prefix="arra-rehearsal-test-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        source_db, source_rows = build_source(root)
        _, target_db = migrate(_ReadOnlySource(source_db), source_rows, root)
        messages = {r["public_id"]: r for r in target_db.open_table("messages").to_arrow().to_pylist()}
        self.assertIn("ภาษาไทย 🌱 ทดสอบ", messages["msg-pub-01"]["content"])
        traces = target_db.open_table("traces").to_arrow().to_pylist()
        self.assertEqual(traces[0]["created_at"], MS_VALUE)
        self.assertEqual(traces[0]["session_from_ts"], MS_VALUE)

    def test_a_deliberately_corrupted_target_row_is_caught(self):
        """A mutation test for the checker itself: if verify_value_level ever
        stopped comparing values, this would still pass silently. Prove it
        actually looks at content by poking one field wrong and re-checking.
        """
        root = Path(tempfile.mkdtemp(prefix="arra-rehearsal-test-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        source_db, source_rows = build_source(root)
        report, target_db = migrate(_ReadOnlySource(source_db), source_rows, root)
        # Overwrite messages with a corrupted row count staying identical.
        model = target_db.open_table("messages").schema
        import pyarrow as pa  # local import: only this test needs it
        target_db.drop_table("messages")
        rows = source_db.open_table("messages").to_arrow().to_pylist()
        rows[0]["content"] = "CORRUPTED"
        from arra_migrate.target_v1 import TARGET_TABLES
        msg_model = TARGET_TABLES["messages"]
        built = []
        for row in rows:
            values = {k: v for k, v in row.items() if k in msg_model.model_fields}
            values.update({"ingested_at": row["created_at"], "source_namespace": None,
                            "source_message_id": None, "source_payload_digest": None,
                            "source_created_at": None})
            built.append(msg_model(**values))
        table = target_db.create_table("messages", schema=msg_model)
        table.add(built)
        problems = verify_value_level(source_db, target_db, report)
        self.assertTrue(any("messages.content" in p for p in problems), problems)


class IdempotencyTests(unittest.TestCase):
    def test_two_independent_runs_from_the_same_deterministic_source_match_exactly(self):
        roots = [Path(tempfile.mkdtemp(prefix=f"arra-rehearsal-test-idem-{i}-")) for i in range(2)]
        for r in roots:
            self.addCleanup(shutil.rmtree, r, ignore_errors=True)
        reports_and_dbs = []
        for r in roots:
            db, rows = build_source(r)
            report, target_db = migrate(_ReadOnlySource(db), rows, r)
            reports_and_dbs.append((report, target_db))
        (report_a, db_a), (report_b, db_b) = reports_and_dbs
        exercised = [n for n, tr in report_a.tables.items() if tr.exercised]
        self.assertGreater(len(exercised), 0)
        for name in exercised:
            with self.subTest(table=name):
                rows_a = db_a.open_table(name).to_arrow().to_pylist()
                rows_b = db_b.open_table(name).to_arrow().to_pylist()
                self.assertEqual(rows_a, rows_b)


class UnitHandlingTests(unittest.TestCase):
    """Requirement 4: the highest-value check, in isolation."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="arra-rehearsal-test-units-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_ms_and_micros_both_round_trip_exactly(self):
        result = prove_unit_handling(self.root)
        self.assertTrue(result["ms_round_trip_exact"])
        self.assertTrue(result["micros_round_trip_exact"])

    def test_the_trap_actually_misfires_when_demonstrated(self):
        result = prove_unit_handling(self.root)
        self.assertTrue(result["trap_misfires_as_designed"])

    def test_float64_could_not_have_represented_the_micros_value_exactly(self):
        result = prove_unit_handling(self.root)
        self.assertTrue(result["float64_would_have_corrupted_it"])

    def test_the_pinned_literals_match_the_brief_exactly(self):
        self.assertEqual(MS_VALUE, 253402300799999)
        self.assertEqual(MICROS_VALUE, 253402300799999000)


class FullRehearsalTests(unittest.TestCase):
    """The end-to-end entry point, run once, checked for internal consistency."""

    def test_run_rehearsal_end_to_end(self):
        result = run_rehearsal()
        self.assertTrue(result["non_destructive"])
        self.assertEqual(result["value_level_problems"], [])
        self.assertTrue(result["idempotent_rerun"])
        self.assertTrue(all(result["unit_handling"].values()))
        self.assertEqual(len(result["report"].tables), 19 + len(REPLACED_SOURCE_ONLY))


if __name__ == "__main__":
    unittest.main()
