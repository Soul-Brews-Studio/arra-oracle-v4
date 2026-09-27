"""Gates for the taxonomy-v1 BARE fixture creator (#48).

The taxonomy kernel bootstraps its own reserved vocabularies and terms, so the
fixture it needs is the opposite of the publication one: nineteen tables, one
workspace row per requested name, and NOTHING else. A fixture that pre-seeded
vocabularies or terms would be answering the questions seed, resume and
conflict are supposed to ask.

What these tests prove:

* input is validated BEFORE the gate is taken, and the gate is taken BEFORE
  ``lancedb.connect`` -- the second shown with a real contending process and a
  sentinel that records whether connect was reached, plus a positive control
  proving the sentinel fires when it should;
* an existing target table is refused with schema, version and row count
  unchanged;
* all nineteen tables are created with the golden physical shape;
* `workspaces` holds exactly the requested rows and the other EIGHTEEN tables
  are empty, `vocabularies` and `terms` included;
* the returned mapping is exactly {workspace: {workspace_id}}, deterministic
  across runs and distinct across workspaces;
* the table listing pages past the deprecated ten-table default.

What they deliberately do NOT prove: any taxonomy semantics. Seeding,
resumption, conflict classification and hook traces are the kernel's gates,
and this creator must stay ignorant of them.

This file lives under ``tests/fixtures/`` where unittest discovery does not
reach. Run it explicitly:

    cd app/migrate-py
    PYTHONPATH=src:tests \
      /opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-spike-s9-rust-18sep-fri2026/app/migrate-py/.venv/bin/python \
      -W error::ResourceWarning \
      tests/fixtures/taxonomy-v1/test_export_taxonomy_fixture.py -v
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import lancedb
import pyarrow as pa
from arra_migrate.target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from arra_migrate.target_v1.schema import describe_schema
from arra_migrate.writer_gate import UnsupportedDatasetError, writer_gate

HERE = Path(__file__).resolve().parent
TESTS_DIR = HERE.parents[1]
MIGRATE_PY = TESTS_DIR.parent
CHILD = HERE / "contention_child.py"
CREATOR = TESTS_DIR / "export_taxonomy_fixture.py"
GOLDEN = json.loads(
    (TESTS_DIR / "fixtures" / "target-v1" / "golden-schema.json").read_text(encoding="utf-8")
)

sys.path.insert(0, str(TESTS_DIR))

# Imported after sys.path is extended above, which is why it is not at the top.
from export_taxonomy_fixture import (  # noqa: E402
    SEED_INSTANT,
    FixtureRefusedError,
    all_table_names,
    create_taxonomy_fixture,
)

# A child that has not finished by now is hung, not slow. The parent enforces
# this rather than trusting the child to exit.
CHILD_DEADLINE_SECONDS = 120.0

# nanoid21 grammar, as the kernel validates it.
NANOID_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")

REFUSED_BEFORE_CONNECT = 0
CONNECT_REACHED = 3
UNEXPECTED = 4


def child_env() -> dict:
    """PYTHONPATH a child needs: the package source and this tests dir."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(MIGRATE_PY / "src"), str(TESTS_DIR)])
    return env


def run_owned_child(argv: list, deadline: float = CHILD_DEADLINE_SECONDS) -> tuple:
    """Run one owned child to completion. Returns (returncode, stdout, stderr).

    The deadline, the kill and the reap belong to the parent: a hung child must
    not be able to hang the suite, and a finished one is still reaped by exact
    pid rather than left for whoever comes along. No pattern kill.
    """
    child = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=child_env(),
        text=True,
    )
    try:
        stdout, stderr = child.communicate(timeout=deadline)
    except subprocess.TimeoutExpired:
        child.kill()
        stdout, stderr = child.communicate()
        raise
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
    return child.returncode, stdout, stderr


def run_contention_child(root: Path, sentinel: Path) -> tuple:
    return run_owned_child([sys.executable, str(CHILD), str(root), str(sentinel)])


def table_state(db, name: str) -> tuple:
    """Schema, version and row count -- what "unchanged" has to mean."""
    table = db.open_table(name)
    return describe_schema(table.schema), table.version, table.count_rows()


class InputValidationOrderTests(unittest.TestCase):
    """Validation happens first, before the gate and before any dataset open."""

    def test_rejects_bad_workspace_lists(self):
        with tempfile.TemporaryDirectory() as tmp:
            for label, workspaces in [
                ("not a list", "alpha"),
                ("empty", []),
                ("blank name", ["   "]),
                ("non-string", [123]),
                ("duplicate", ["alpha", "alpha"]),
                ("oversize", ["w" * 257]),
            ]:
                with self.subTest(case=label), self.assertRaises((TypeError, ValueError)):
                    create_taxonomy_fixture(tmp, workspaces=workspaces)
            # Nothing was created on the way to any of those refusals.
            self.assertEqual(sorted(Path(tmp).iterdir()), [])

    def test_validates_the_request_before_taking_the_gate(self):
        # Another owner holds the gate. A malformed request must still fail as
        # a request, not as contention: that ordering is what "validates all
        # input first" means, and the failure mode it rules out is a creator
        # that reports writer_unavailable for a call it would have rejected.
        with (
            tempfile.TemporaryDirectory() as tmp,
            writer_gate(tmp),
            self.assertRaises((TypeError, ValueError)),
        ):
            create_taxonomy_fixture(tmp, workspaces=[])

    def test_rejects_a_dataset_root_that_is_not_an_existing_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "not-created-by-this-creator"
            with self.assertRaises(UnsupportedDatasetError):
                create_taxonomy_fixture(str(missing), workspaces=["alpha"])
            self.assertFalse(missing.exists())


class WriterGateOrderTests(unittest.TestCase):
    """The gate runs ahead of the dataset open, and is really released."""

    def test_contender_is_refused_before_lancedb_connect(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dataset"
            root.mkdir()
            sentinel = Path(tmp) / "connect-was-reached"
            with writer_gate(str(root)):
                rc, stdout, stderr = run_contention_child(root, sentinel)
            self.assertEqual(rc, REFUSED_BEFORE_CONNECT, msg=f"{stdout}\n{stderr}")
            self.assertFalse(sentinel.exists(), "lancedb.connect was reached under contention")
            self.assertEqual(json.loads(stdout.strip())["code"], "writer_unavailable")

    def test_the_sentinel_really_fires_when_the_gate_is_free(self):
        # Positive control. Without this, "the sentinel file is absent" is
        # equally consistent with a sentinel that never works at all.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dataset"
            root.mkdir()
            sentinel = Path(tmp) / "connect-was-reached"
            rc, stdout, stderr = run_contention_child(root, sentinel)
            self.assertTrue(sentinel.exists(), f"sentinel never fired: {stdout}\n{stderr}")
            # With the gate free the child DOES reach connect, and its own
            # exit code says so. That is the control working, not a defect:
            # the contention run above is only meaningful because this run
            # shows the sentinel is capable of firing at all.
            self.assertEqual(rc, CONNECT_REACHED, msg=f"{stdout}\n{stderr}")

    def test_the_gate_is_still_held_while_the_tables_are_created(self):
        # Taking the lock and dropping it before the slow part would pass the
        # test above and still leave creation unprotected, so a contender is
        # launched from INSIDE the creator's own connect call.
        observed = {}
        original_connect = lancedb.connect
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dataset"
            root.mkdir()
            sentinel = Path(tmp) / "connect-was-reached"

            def connect_then_contend(*args, **kwargs):
                observed["child"] = run_contention_child(root, sentinel)
                return original_connect(*args, **kwargs)

            lancedb.connect = connect_then_contend
            try:
                create_taxonomy_fixture(str(root), workspaces=["alpha-workspace"])
            finally:
                lancedb.connect = original_connect

        rc, stdout, stderr = observed["child"]
        self.assertEqual(rc, REFUSED_BEFORE_CONNECT, msg=f"{stdout}\n{stderr}")
        self.assertFalse(sentinel.exists())

    def test_gate_is_released_and_reusable_after_the_owner_returns(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dataset"
            root.mkdir()
            create_taxonomy_fixture(str(root), workspaces=["alpha-workspace"])
            # Closing releases the flock; if it did not, this would raise.
            with writer_gate(str(root)):
                pass


class RefusesReplacementTests(unittest.TestCase):
    """An existing target table is refused, never replaced."""

    def test_existing_target_table_is_refused_with_state_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dataset"
            root.mkdir()
            db = lancedb.connect(str(root))
            db.create_table("terms", schema=TARGET_TABLES["terms"])
            before = table_state(db, "terms")

            with self.assertRaises(FixtureRefusedError):
                create_taxonomy_fixture(str(root), workspaces=["alpha-workspace"])

            after_db = lancedb.connect(str(root))
            self.assertEqual(table_state(after_db, "terms"), before)
            # No partial creation either: the refusal is before any table work.
            self.assertEqual(all_table_names(after_db), ["terms"])

    def test_refusal_names_the_existing_tables_without_replacing_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dataset"
            root.mkdir()
            db = lancedb.connect(str(root))
            db.create_table("workspaces", schema=TARGET_TABLES["workspaces"])
            with self.assertRaises(FixtureRefusedError) as raised:
                create_taxonomy_fixture(str(root), workspaces=["alpha-workspace"])
            self.assertIn("workspaces", str(raised.exception))
            self.assertEqual(lancedb.connect(str(root)).open_table("workspaces").count_rows(), 0)


class CreatedDatasetTests(unittest.TestCase):
    """Nineteen tables with the golden shape, and only workspaces seeded."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name) / "taxonomy-v1-lancedb"
        cls.root.mkdir()
        cls.workspaces = ["alpha-workspace", "beta-workspace"]
        cls.ids = create_taxonomy_fixture(str(cls.root), workspaces=cls.workspaces)
        cls.db = lancedb.connect(str(cls.root))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_creates_exactly_the_nineteen_target_tables(self):
        self.assertEqual(sorted(all_table_names(self.db)), sorted(TARGET_TABLE_NAMES))

    def test_table_listing_pages_past_the_ten_table_default(self):
        # The deprecated `table_names` defaults to ten. A creator that used it
        # would see ten of nineteen and could overwrite the eleventh.
        self.assertEqual(len(all_table_names(self.db)), 19)

    def test_persisted_schema_matches_the_golden_for_every_table(self):
        for name in TARGET_TABLE_NAMES:
            with self.subTest(table=name):
                persisted = describe_schema(self.db.open_table(name).schema)
                self.assertEqual([list(f) for f in persisted], GOLDEN["tables"][name])

    def test_seeds_only_workspaces_and_leaves_the_other_eighteen_empty(self):
        counts = {name: self.db.open_table(name).count_rows() for name in TARGET_TABLE_NAMES}
        self.assertEqual(counts.pop("workspaces"), len(self.workspaces))
        self.assertEqual(len(counts), 18)
        for name, count in sorted(counts.items()):
            with self.subTest(table=name):
                self.assertEqual(count, 0)

    def test_taxonomy_tables_are_bare_so_the_kernel_bootstraps_them(self):
        # Stated separately from the sweep above because it is the whole point
        # of this fixture: seed, resume and conflict must start from nothing.
        self.assertEqual(self.db.open_table("vocabularies").count_rows(), 0)
        self.assertEqual(self.db.open_table("terms").count_rows(), 0)

    def test_returned_shape_is_exactly_the_frozen_mapping(self):
        self.assertEqual(sorted(self.ids), sorted(self.workspaces))
        for name in self.workspaces:
            with self.subTest(workspace=name):
                self.assertEqual(sorted(self.ids[name]), ["workspace_id"])

    def test_workspace_ids_are_nanoid21_and_distinct_per_workspace(self):
        seen = set()
        for name in self.workspaces:
            workspace_id = self.ids[name]["workspace_id"]
            with self.subTest(workspace=name):
                self.assertIsInstance(workspace_id, str)
                self.assertEqual(len(workspace_id), 21)
                self.assertTrue(set(workspace_id) <= NANOID_CHARS)
            seen.add(workspace_id)
        self.assertEqual(len(seen), len(self.workspaces))

    def test_persisted_rows_carry_the_returned_identity_and_the_pinned_instant(self):
        rows = self.db.open_table("workspaces").search().limit(100).to_list()
        by_name = {row["name"]: row for row in rows}
        self.assertEqual(sorted(by_name), sorted(self.workspaces))
        for name in self.workspaces:
            row = by_name[name]
            with self.subTest(workspace=name):
                self.assertEqual(row["id"], self.ids[name]["workspace_id"])
                # Pinned, not "now": a fixture whose contents move with the
                # clock cannot be compared against itself across two runs.
                self.assertEqual(row["created_at"], SEED_INSTANT)
                self.assertIsNone(row["h_metadata"])
                self.assertIsNone(row["internal_metadata"])
                self.assertIsNone(row["configuration"])
                self.assertIsNone(row["mission"])

    def test_stored_timestamp_is_exactly_millisecond_aligned(self):
        arrow = self.db.open_table("workspaces").to_arrow()
        column = arrow.column("created_at").combine_chunks()
        micros = column.cast(pa.int64()).to_pylist()
        for value in micros:
            with self.subTest(micros=value):
                self.assertEqual(value % 1000, 0)


class DeterminismTests(unittest.TestCase):
    """Two runs of the same request produce the same identities."""

    def test_two_independent_runs_return_identical_identities(self):
        names = ["alpha-workspace", "beta-workspace"]
        produced = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "dataset"
                root.mkdir()
                produced.append(create_taxonomy_fixture(str(root), workspaces=names))
        self.assertEqual(produced[0], produced[1])

    def test_a_workspace_id_depends_on_its_own_name_only(self):
        # Same name in a different request must keep the same id, or a test
        # that seeds one workspace and then another cannot compare them.
        with tempfile.TemporaryDirectory() as tmp:
            first_root = Path(tmp) / "one"
            first_root.mkdir()
            second_root = Path(tmp) / "two"
            second_root.mkdir()
            alone = create_taxonomy_fixture(str(first_root), workspaces=["alpha-workspace"])
            together = create_taxonomy_fixture(
                str(second_root), workspaces=["alpha-workspace", "beta-workspace"]
            )
            self.assertEqual(alone["alpha-workspace"], together["alpha-workspace"])


class CommandLineTests(unittest.TestCase):
    """The CLI shape the TypeScript helper consumes."""

    def test_cli_emits_one_json_line_of_the_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dataset"
            root.mkdir()
            rc, stdout, stderr = run_owned_child(
                [sys.executable, str(CREATOR), str(root), "alpha-workspace", "beta-workspace"]
            )
            self.assertEqual(rc, 0, msg=f"{stdout}\n{stderr}")
            lines = [line for line in stdout.splitlines() if line.strip()]
            self.assertEqual(len(lines), 1, msg=f"expected one JSON line, got: {lines}")
            mapping = json.loads(lines[0])
            self.assertEqual(sorted(mapping), ["alpha-workspace", "beta-workspace"])
            for name, entry in mapping.items():
                with self.subTest(workspace=name):
                    self.assertEqual(sorted(entry), ["workspace_id"])
            # The CLI wrote the dataset it reported on.
            db = lancedb.connect(str(root))
            self.assertEqual(sorted(all_table_names(db)), sorted(TARGET_TABLE_NAMES))
            self.assertEqual(db.open_table("workspaces").count_rows(), 2)

    def test_cli_refuses_a_second_run_over_the_same_dataset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dataset"
            root.mkdir()
            first = run_owned_child([sys.executable, str(CREATOR), str(root), "alpha-workspace"])
            self.assertEqual(first[0], 0, msg=f"{first[1]}\n{first[2]}")
            second = run_owned_child([sys.executable, str(CREATOR), str(root), "alpha-workspace"])
            self.assertNotEqual(second[0], 0)
            self.assertEqual(lancedb.connect(str(root)).open_table("workspaces").count_rows(), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
