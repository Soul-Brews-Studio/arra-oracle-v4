"""#34 copy migration: refusals, faults, and what a failed run leaves behind.

Each test owns a fresh ``mktemp -d`` tree with the legacy-15 fixture. A run
that fails must (a) raise, (b) leave the ORIGINAL source byte-identical, (c)
write no report that could read as success, and (d) leave the candidate with
NO tables -- a half-written 19-table candidate passes ``assertTargetDataset``
(shape only) and could be mounted by mistake. A rerun into the same candidate
must then converge.

The mid-knowledge-phase crash is deterministic, not timed: the Bun crash child
(``app/server/test/fixtures/migration/crash-worker.ts``) runs the REAL worker
and SIGKILLs itself from the kernel's own ``after_revision_append`` boundary
on the third publish -- a revision row appended, its head not yet published.
"""

from __future__ import annotations

import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import lancedb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from copy_migration_support import INTAKE_AT, records, tree
from copy_migration_support import rows as _rows
from copy_migration_support import run as _run
from export_legacy_fixture import LAB, LONG_TYPE, build_legacy_fixture

CRASH_CHILD = Path(__file__).resolve().parents[2] / "server" / "test" / "fixtures" / "migration" / "crash-worker.ts"


def _tables(root: Path) -> list[str]:
    return sorted(lancedb.connect(str(root)).table_names(limit=1000))


class RefusalTests(unittest.TestCase):
    def setUp(self):
        self.parent = Path(tempfile.mkdtemp(prefix="arra-copy-refusal-"))
        self.addCleanup(shutil.rmtree, self.parent, ignore_errors=True)
        build_legacy_fixture(self.parent / "source")

    def test_refuses_a_non_empty_candidate_before_any_write(self):
        from arra_migrate.copy_migration import CopyMigrationRefused, run_copy_migration

        candidate = self.parent / "candidate"
        candidate.mkdir()
        (candidate / "keep.txt").write_text("operator data")
        before = tree(candidate)
        with self.assertRaises(CopyMigrationRefused) as ctx:
            run_copy_migration(self.parent / "source", candidate, self.parent / "work", intake_at=INTAKE_AT)
        self.assertEqual(ctx.exception.code, "candidate_not_empty")
        self.assertEqual(tree(candidate), before)
        self.assertFalse((self.parent / "work").exists(), "nothing written anywhere")

    def test_refuses_remote_roots(self):
        from arra_migrate.copy_migration import CopyMigrationRefused, run_copy_migration

        candidate = self.parent / "candidate"
        candidate.mkdir()
        for source, cand in (("s3://bucket/legacy", candidate), (self.parent / "source", "s3://bucket/c")):
            with self.subTest(source=str(source), candidate=str(cand)):
                with self.assertRaises(CopyMigrationRefused) as ctx:
                    run_copy_migration(source, cand, self.parent / "work", intake_at=INTAKE_AT)
                self.assertEqual(ctx.exception.code, "remote_root")
        self.assertEqual(list(candidate.iterdir()), [])

    def test_refuses_a_sub_millisecond_intake_time(self):
        from arra_migrate.copy_migration import CopyMigrationRefused, run_copy_migration

        candidate = self.parent / "candidate"
        candidate.mkdir()
        with self.assertRaises(CopyMigrationRefused) as ctx:
            run_copy_migration(self.parent / "source", candidate, self.parent / "work",
                               intake_at="2026-09-26T14:00:00.000123Z")
        self.assertEqual(ctx.exception.code, "invalid_intake_at")


class FailedRunTests(unittest.TestCase):
    def setUp(self):
        self.parent = Path(tempfile.mkdtemp(prefix="arra-copy-fault-"))
        self.addCleanup(shutil.rmtree, self.parent, ignore_errors=True)
        build_legacy_fixture(self.parent / "source")
        self.candidate = self.parent / "candidate"
        self.candidate.mkdir()
        self.before = tree(self.parent / "source")

    def _fail(self, **kwargs):
        from arra_migrate.copy_migration import CopyMigrationFailed, run_copy_migration

        with self.assertRaises(CopyMigrationFailed) as ctx:
            run_copy_migration(self.parent / "source", self.candidate, self.parent / "failed-work",
                               intake_at=INTAKE_AT, **kwargs)
        self.assertEqual(tree(self.parent / "source"), self.before)
        self.assertFalse((self.parent / "failed-work" / "report.json").exists(),
                         "no report that could read as success")
        self.assertEqual(_tables(self.candidate), [], "a failed run discards every table it created")
        return str(ctx.exception)

    def _rerun_converges(self):
        from arra_migrate.copy_migration import run_copy_migration

        report = run_copy_migration(self.parent / "source", self.candidate, self.parent / "rerun-work",
                                    intake_at=INTAKE_AT)
        self.assertTrue(report["verified"])
        self.assertEqual(len(_rows(self.candidate, "nodes")), 9)
        self.assertEqual(tree(self.parent / "source"), self.before)

    def test_a_worker_that_dies_at_once_fails_loud_and_leaves_no_tables(self):
        # `false` stands in for a Bun worker that dies: exit 1, no lines.
        self._fail(bun=shutil.which("false"))
        self._rerun_converges()

    def test_a_worker_past_its_deadline_is_killed_and_the_candidate_discarded(self):
        message = self._fail(worker_deadline_seconds=0.001)
        self.assertIn("exceeded", message)

    def test_sigkill_mid_knowledge_phase_discards_the_candidate_and_a_rerun_converges(self):
        self.assertTrue(CRASH_CHILD.is_file(), CRASH_CHILD)
        bun = shutil.which("bun")
        wrapper = self.parent / "crash-bun"
        # worker.py calls `<bun> run <worker script> <plan.json>`; swap in the crash child.
        wrapper.write_text(f'#!/bin/sh\nexec "{bun}" run "{CRASH_CHILD}" "$3"\n')
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
        message = self._fail(bun=str(wrapper))
        self.assertIn("exited -9", message, "killed by SIGKILL, not a clean refusal")
        self._rerun_converges()


class KernelRefusedTagTests(unittest.TestCase):
    """Defence in depth for R11: if a legacy type string passes the Python
    bound but the kernel refuses it as a term name, only the memories carrying
    that tag are rejected -- the workspace's other memories still publish."""

    @classmethod
    def setUpClass(cls):
        from arra_migrate.copy_migration import plan

        cls.parent = Path(tempfile.mkdtemp(prefix="arra-copy-kernel-tag-"))
        build_legacy_fixture(cls.parent / "source")
        with mock.patch.object(plan, "LEGACY_TYPE_TAG_MAX_BYTES", 10_000):
            cls.report, cls.candidate, cls.work = _run(cls.parent, "patched")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.parent, ignore_errors=True)

    def test_only_the_memory_with_the_refused_tag_is_rejected(self):
        memories = {r["legacy_key"]: r for r in records(self.work) if r["table"] == "memories"}
        refused = memories["m_muigr6gg_longtype"]
        self.assertEqual((refused["outcome"], refused["code"], refused["pointer"]),
                         ("rejected", "legacy_type_term_unavailable", "/type"))
        lab = [k for k, r in memories.items() if r["workspace"] == LAB and r["outcome"] == "migrated"]
        self.assertEqual(len(lab), 6)
        self.assertEqual(len(_rows(self.candidate, "nodes")), 9)
        self.assertTrue(self.report["conservation_ok"])

    def test_the_kernel_refusal_is_on_the_report(self):
        failed = [t for t in self.report["readback"]["taxonomy"] if t["outcome"] == "error"]
        self.assertEqual(len(failed), 1)
        self.assertEqual((failed[0]["code"], failed[0]["path"]), ("limit_exceeded", "/name"))
        self.assertEqual(failed[0]["step"], f"legacy_type_term:{LONG_TYPE}")
        tags = {t["name"] for t in _rows(self.candidate, "terms") if t["workspace_name"] == LAB}
        self.assertTrue({"retro", "Decision Log"} <= tags, "the other R11 tags were still created")


if __name__ == "__main__":
    unittest.main()
