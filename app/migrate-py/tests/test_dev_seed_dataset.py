"""Millisecond-alignment gate for the dev-stack's target19 seed script (#105/#75).

`app/just/scripts/create_target19_dataset.py` is the only writer of the
`workspaces` row every dev-stack context method reads. Its `created_at` column
is physical `timestamp[us]` (`storage.ts`'s `TARGET_SCHEMA`), and every context
kernel that structurally validates a workspace row (`read-cursor.ts`'s
`validateWorkspaceRow`) fails closed on a non-zero microsecond remainder --
correctly, per `context-ingestion-v1.md:57` and `read-cursor-v1.md:30`. Before
this fix the script seeded `datetime.now(timezone.utc)`, which carries genuine
microsecond precision 999 times in 1000, so `getReadCursor`/`advanceReadCursor`
against a freshly seeded dev dataset threw `integrity_failure` almost always
(measured: `.tmp/understand/issue-75/`).

This is NOT the LanceDB JS `timestamp[us]` unit confusion #105 first blamed
(see LANCEDB-FACTS.md and `mcp/connections.ts`): reading back a physical
microsecond value through `to_arrow().to_pylist()` in Python loses nothing --
Python's `datetime` already carries microsecond resolution. The remainder these
tests catch is real data, not an accessor artifact.

Determinism: `main()` takes an injectable `now`, so these tests never rely on
`datetime.now()` landing on a whole millisecond by chance (about 1 time in
1000).
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import lancedb

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "just" / "scripts" / "create_target19_dataset.py"


def _load_script():
    """Import the script fresh by path, the way `test_writer_gate.py`-style
    fixtures load standalone scripts that are not an installed package."""
    spec = importlib.util.spec_from_file_location("create_target19_dataset", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _default_row(root: str) -> dict:
    db = lancedb.connect(root)
    rows = db.open_table("workspaces").to_arrow().to_pylist()
    matches = [r for r in rows if r["name"] == "default"]
    assert len(matches) == 1, f"expected exactly one 'default' workspace row, found {len(matches)}"
    return matches[0]


class SeedMillisecondAlignmentTests(unittest.TestCase):
    """T1: the script's OWN write must be millisecond-aligned."""

    def test_freshly_seeded_default_row_has_no_microsecond_remainder(self):
        module = _load_script()
        injected = datetime(2026, 9, 21, 0, 0, 0, 383920, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as root:
            rc = module.main([root], now=injected)
            self.assertEqual(rc, 0)
            row = _default_row(root)
            self.assertEqual(row["created_at"].microsecond % 1000, 0)
            # Exact truncation, not rounding: .383920 -> .383000.
            self.assertEqual(row["created_at"].microsecond, 383000)

    def test_real_clock_seed_is_also_aligned(self):
        """No injected clock at all -- the production default path. Pre-fix
        this is red about 999 times in 1000; the injected-clock test above is
        what makes the red deterministic."""
        module = _load_script()
        with tempfile.TemporaryDirectory() as root:
            rc = module.main([root])
            self.assertEqual(rc, 0)
            row = _default_row(root)
            self.assertEqual(row["created_at"].microsecond % 1000, 0)

    def test_existing_sub_millisecond_default_row_is_refused_not_silently_ok(self):
        """The idempotent branch must not print "ok" over bad data. A dataset
        created by the OLD (unfixed) script, or corrupted some other way, must
        fail loudly and tell the operator to regenerate -- never repair data
        silently (no ruling authorizes that)."""
        module = _load_script()
        with tempfile.TemporaryDirectory() as root:
            # Seed once through the fixed path so every other table exists,
            # then corrupt only the one row this script's idempotent branch
            # would otherwise bless with "ok".
            rc = module.main([root], now=datetime(2026, 9, 21, 0, 0, 0, 0, tzinfo=timezone.utc))
            self.assertEqual(rc, 0)
            db = lancedb.connect(root)
            table = db.open_table("workspaces")
            table.update(where="name = 'default'", values={"created_at": datetime(2026, 9, 21, 0, 0, 0, 383920)})
            table.checkout_latest()
            corrupted = _default_row(root)
            self.assertEqual(corrupted["created_at"].microsecond, 383920)

            rc = module.main([root])
            self.assertNotEqual(rc, 0, "must refuse, not print ok, over a sub-millisecond row")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
