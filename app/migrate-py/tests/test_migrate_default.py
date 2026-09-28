"""R32 (Nat 2026-09-28, #135): `python -m arra_migrate` creates target-19 by default.

The cutover rehearsal found no live v4 data -- production is v3 SQLite, and the
only v4 LanceDB datasets are empty dev ones -- so v4 starts FRESH on the
19-table target instead of migrating anything. The legacy active-15 registry
stays reachable, but only behind the explicit `--legacy-active15` flag,
because the server's legacy `/api/memories` routes and startup FTS work still
open the `memories` table in `ARRA_DATA_DIR`.

Every test runs the real module as a subprocess against a fresh
`tempfile.mkdtemp` root. Nothing here reads `app/data`, `app/.tmp` or `~/`.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import lancedb

from arra_migrate.models import TABLES as ACTIVE_TABLES
from arra_migrate.target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from arra_migrate.target_v1.schema import describe_schema

SRC = Path(__file__).resolve().parents[1] / "src"


def _migrate(root: str, *args: str) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if k != "ARRA_RESET"}
    env.update(ARRA_DATA_DIR=root, PYTHONPATH=str(SRC))
    return subprocess.run(
        [sys.executable, "-m", "arra_migrate", *args],
        env=env, capture_output=True, text=True, timeout=180,
    )


def _tables(root: str) -> set[str]:
    return set(lancedb.connect(root).table_names(limit=1000))


class MigrateDefaultTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="arra-migrate-default-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_default_creates_exactly_the_nineteen_target_tables_with_their_schemas(self):
        result = _migrate(self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(_tables(self.root), set(TARGET_TABLE_NAMES))
        db = lancedb.connect(self.root)
        for name in TARGET_TABLE_NAMES:
            with self.subTest(table=name):
                self.assertEqual(
                    describe_schema(db.open_table(name).schema),
                    describe_schema(TARGET_TABLES[name].to_arrow_schema()),
                )
        # The replaced legacy tables must not appear on a fresh default install.
        self.assertNotIn("memories", _tables(self.root))
        self.assertNotIn("memory_terms", _tables(self.root))

    def test_default_check_passes_on_a_fresh_default_dataset(self):
        self.assertEqual(_migrate(self.root).returncode, 0)
        result = _migrate(self.root, "--check")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_legacy_flag_still_creates_the_active_fifteen(self):
        result = _migrate(self.root, "--legacy-active15")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(_tables(self.root), set(ACTIVE_TABLES))
        self.assertEqual(len(ACTIVE_TABLES), 15)
        check = _migrate(self.root, "--legacy-active15", "--check")
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)

    def test_default_refuses_a_legacy_root_and_creates_nothing(self):
        # Re-running the bare command on an existing legacy dataset (the old
        # default) must not bolt the six target-only tables onto it.
        self.assertEqual(_migrate(self.root, "--legacy-active15").returncode, 0)
        before = _tables(self.root)
        result = _migrate(self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--legacy-active15", result.stderr)
        self.assertEqual(_tables(self.root), before)
        self.assertNotEqual(_migrate(self.root, "--check").returncode, 0)

    def test_legacy_flag_refuses_a_target_root_and_creates_nothing(self):
        self.assertEqual(_migrate(self.root).returncode, 0)
        before = _tables(self.root)
        result = _migrate(self.root, "--legacy-active15")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(_tables(self.root), before)

    def test_unknown_flags_are_rejected_before_anything_is_created(self):
        # A typo like `--legacy` must not silently fall through to the default.
        result = _migrate(self.root, "--legacy")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(_tables(self.root), set())


if __name__ == "__main__":
    unittest.main()
