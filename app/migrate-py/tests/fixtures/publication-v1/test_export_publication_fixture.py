"""Gates for the publication-v1 fixture creator.

What these tests prove:

* the writer gate is taken BEFORE the dataset is opened -- demonstrated with a
  real second process and a sentinel that records whether ``lancedb.connect``
  was reached, not merely with the exception type;
* a dataset that already holds any of the nineteen target tables is refused,
  and its schema, table version and row count are unchanged afterwards;
* all nineteen tables are created with the physical shape the checked-in
  golden schema describes;
* the returned identities are scoped per workspace -- two workspaces created in
  one call share no id.

What they deliberately do NOT prove: publication semantics, canonical bytes,
digests, ancestry or idempotency. Those are the TypeScript kernel's gates.

This file lives under ``tests/fixtures/`` and unittest discovery does not reach
it. Run it explicitly:

    cd app/migrate-py
    PYTHONPATH=src:tests \
      /opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-spike-s9-rust-18sep-fri2026/app/migrate-py/.venv/bin/python \
      -W error::ResourceWarning \
      tests/fixtures/publication-v1/test_export_publication_fixture.py -v
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import lancedb

from arra_migrate.target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from arra_migrate.target_v1.schema import describe_schema
from arra_migrate.writer_gate import writer_gate

HERE = Path(__file__).resolve().parent
TESTS_DIR = HERE.parents[1]
MIGRATE_PY = TESTS_DIR.parent
CHILD = HERE / "contention_child.py"
GOLDEN = json.loads(
    (TESTS_DIR / "fixtures" / "target-v1" / "golden-schema.json").read_text(encoding="utf-8")
)

sys.path.insert(0, str(TESTS_DIR))

from export_publication_fixture import (
    SEED_INSTANT,
    FixtureRefusedError,
    all_table_names,
    create_publication_fixture,
)

# A child that has not finished by now is a hung child, not a slow one. The
# parent enforces this itself rather than trusting the child to exit.
CHILD_DEADLINE_SECONDS = 120.0


def child_env() -> dict:
    """PYTHONPATH the child needs: the package source and this tests dir."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(MIGRATE_PY / "src"), str(TESTS_DIR)])
    return env


def run_contention_child(root: Path, sentinel: Path) -> tuple:
    """Run the owned child once. Returns (returncode, stdout, stderr, seconds).

    The deadline and the kill/reap are the PARENT's job: a child that hangs
    must not be able to hang the suite, and a child that exits must still be
    reaped by exact pid rather than left for whoever comes along.
    """
    started = time.monotonic()
    child = subprocess.Popen(
        [sys.executable, str(CHILD), str(root), str(sentinel)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=child_env(),
        text=True,
    )
    try:
        stdout, stderr = child.communicate(timeout=CHILD_DEADLINE_SECONDS)
    except subprocess.TimeoutExpired:
        child.kill()
        stdout, stderr = child.communicate()
        raise
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
    return child.returncode, stdout, stderr, time.monotonic() - started


class WriterGateOrderTests(unittest.TestCase):
    """The gate must refuse a contender before the dataset is ever opened."""

    def test_contender_is_refused_before_lancedb_connect(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "publication-v1-lancedb"
            root.mkdir()
            sentinel = Path(tmp) / "connect-was-reached"

            # The parent owns the gate for the whole life of the child.
            with writer_gate(root):
                rc, stdout, stderr, elapsed = run_contention_child(root, sentinel)

            self.assertEqual(rc, 0, f"rc={rc}\nstdout={stdout}\nstderr={stderr}")
            self.assertFalse(
                sentinel.exists(),
                "lancedb.connect was reached: the gate is not ahead of the dataset open",
            )
            self.assertEqual(
                json.loads(stdout.strip()),
                {"outcome": "writer_unavailable", "code": "writer_unavailable"},
            )
            # The refusal is non-blocking: it must not have waited for the gate.
            self.assertLess(elapsed, CHILD_DEADLINE_SECONDS)

    def test_the_sentinel_really_fires_when_the_gate_is_free(self):
        """Without this, the assertion above could pass on a dead sentinel.

        An absent sentinel only means "connect was not reached" if the sentinel
        would have appeared had connect been reached. So: same child, same
        path, no contending owner.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "publication-v1-lancedb"
            root.mkdir()
            sentinel = Path(tmp) / "connect-was-reached"

            rc, stdout, stderr, _ = run_contention_child(root, sentinel)

            self.assertEqual(rc, 3, f"rc={rc}\nstdout={stdout}\nstderr={stderr}")
            self.assertTrue(sentinel.exists())

    def test_the_gate_is_still_held_while_the_tables_are_created(self):
        """Acquiring early is not enough; it has to still be held at connect.

        The probe runs a real contender from inside the creator's own call to
        ``lancedb.connect`` -- that is, after acquisition and before any table
        exists -- and requires it to be refused there.
        """
        import export_publication_fixture as exporter

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "publication-v1-lancedb"
            root.mkdir()
            sentinel = Path(tmp) / "connect-was-reached"
            observed = {}
            real_connect = exporter.lancedb.connect

            def probing_connect(*args, **kwargs):
                observed["child"] = run_contention_child(root, sentinel)
                return real_connect(*args, **kwargs)

            exporter.lancedb.connect = probing_connect
            try:
                ids = create_publication_fixture(str(root), workspaces=["alpha-workspace"])
            finally:
                exporter.lancedb.connect = real_connect

            rc, stdout, stderr, _ = observed["child"]
            self.assertEqual(rc, 0, f"rc={rc}\nstdout={stdout}\nstderr={stderr}")
            self.assertFalse(sentinel.exists())
            self.assertEqual(sorted(ids), ["alpha-workspace"])

    def test_gate_is_released_and_reusable_after_the_owner_returns(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "publication-v1-lancedb"
            root.mkdir()
            create_publication_fixture(str(root), workspaces=["alpha-workspace"])
            # If creation had leaked the descriptor, this would raise.
            with writer_gate(root) as fd:
                self.assertIsInstance(fd, int)


class RefusesReplacementTests(unittest.TestCase):
    """An existing target table is never replaced, reset or written over."""

    def test_existing_table_is_refused_with_state_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "publication-v1-lancedb"
            root.mkdir()

            # Seed ONE of the nineteen by hand, under the same gate the creator
            # uses, so the refusal is about the table existing and nothing else.
            with writer_gate(root):
                db = lancedb.connect(str(root))
                model = TARGET_TABLES["workspaces"]
                table = db.create_table("workspaces", schema=model)
                table.add([
                    model(
                        id="pre-existing-row-000000",
                        name="pre-existing-workspace",
                        created_at=SEED_INSTANT,
                    )
                ])

            before = self.state(root, "workspaces")

            with self.assertRaises(FixtureRefusedError):
                create_publication_fixture(str(root), workspaces=["alpha-workspace"])

            self.assertEqual(self.state(root, "workspaces"), before)
            # Nothing else got created on the way to the refusal either.
            self.assertEqual(sorted(all_table_names(lancedb.connect(str(root)))), ["workspaces"])

    def state(self, root: Path, table: str) -> dict:
        handle = lancedb.connect(str(root)).open_table(table)
        return {
            "schema": describe_schema(handle.schema),
            "version": handle.version,
            "rows": handle.count_rows(),
        }


class CreatedDatasetTests(unittest.TestCase):
    """The created dataset is the reviewed nineteen with the golden shape."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name) / "publication-v1-lancedb"
        cls.root.mkdir()
        cls.workspaces = ["alpha-workspace", "beta-workspace"]
        cls.ids = create_publication_fixture(str(cls.root), workspaces=cls.workspaces)
        cls.db = lancedb.connect(str(cls.root))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_creates_exactly_the_nineteen_target_tables(self):
        self.assertEqual(sorted(all_table_names(self.db)), sorted(TARGET_TABLE_NAMES))

    def test_persisted_schema_matches_the_golden_for_every_table(self):
        for name in TARGET_TABLE_NAMES:
            with self.subTest(table=name):
                persisted = describe_schema(self.db.open_table(name).schema)
                self.assertEqual([list(f) for f in persisted], GOLDEN["tables"][name])

    def test_seeds_only_the_reference_tables_and_leaves_publication_empty(self):
        counts = {name: self.db.open_table(name).count_rows() for name in TARGET_TABLE_NAMES}
        n = len(self.workspaces)
        self.assertEqual(counts["workspaces"], n)
        self.assertEqual(counts["peers"], 2 * n)
        self.assertEqual(counts["sessions"], n)
        self.assertEqual(counts["session_peers"], 2 * n)
        self.assertEqual(counts["messages"], n)
        self.assertEqual(counts["vocabularies"], 3 * n)
        self.assertEqual(counts["terms"], 5 * n)
        self.assertEqual(counts["traces"], n)
        # The kernel publishes these; the fixture must not pre-empt it.
        for empty in (
            "nodes",
            "node_revisions",
            "node_revision_terms",
            "revision_links",
            "supersede_log",
            "search_chunks_v1",
            "session_links",
            "trace_hits",
            "mcp_calls",
            "connections",
            "read_cursors",
        ):
            with self.subTest(table=empty):
                self.assertEqual(counts[empty], 0)

    def test_returned_shape_is_the_frozen_contract(self):
        self.assertEqual(sorted(self.ids), sorted(self.workspaces))
        for name in self.workspaces:
            entry = self.ids[name]
            with self.subTest(workspace=name):
                self.assertEqual(
                    sorted(entry),
                    [
                        "message_public_id",
                        "peer_names",
                        "session_name",
                        "term_ids",
                        "trace_id",
                        "vocabulary_ids",
                        "workspace_id",
                    ],
                )
                self.assertEqual(len(entry["peer_names"]), 2)
                self.assertEqual(
                    sorted(entry["vocabulary_ids"]), ["memory_horizon", "topic", "type"]
                )
                self.assertEqual(sorted(entry["term_ids"]), ["memory_horizon", "topic", "type"])
                self.assertEqual(sorted(entry["term_ids"]["type"]), ["decision", "note"])
                for vocabulary, terms in entry["term_ids"].items():
                    for term_name, term in terms.items():
                        self.assertEqual(term["name"], term_name)
                        self.assertEqual(term["vocabulary_name"], vocabulary)
                        self.assertEqual(
                            term["vocabulary_id"], entry["vocabulary_ids"][vocabulary]
                        )

    def test_exactly_one_retired_term_per_workspace(self):
        for name in self.workspaces:
            with self.subTest(workspace=name):
                retired = [
                    term
                    for terms in self.ids[name]["term_ids"].values()
                    for term in terms.values()
                    if not term["is_active"]
                ]
                self.assertEqual([t["name"] for t in retired], ["retired_topic"])

    def test_two_active_type_terms_so_cardinality_one_is_testable(self):
        for name in self.workspaces:
            with self.subTest(workspace=name):
                type_terms = self.ids[name]["term_ids"]["type"]
                self.assertTrue(all(t["is_active"] for t in type_terms.values()))
                self.assertEqual(len(type_terms), 2)

    def test_ids_are_scoped_per_workspace(self):
        alpha, beta = (self.collect_ids(w) for w in self.workspaces)
        self.assertEqual(len(alpha), len(beta))
        self.assertEqual(alpha & beta, set())

    def test_every_returned_id_is_a_nanoid21(self):
        alphabet = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        for name in self.workspaces:
            for value in self.collect_ids(name):
                with self.subTest(workspace=name, value=value):
                    self.assertEqual(len(value), 21)
                    self.assertTrue(set(value) <= alphabet)

    def test_persisted_rows_carry_the_returned_identities(self):
        for name in self.workspaces:
            entry = self.ids[name]
            with self.subTest(workspace=name):
                workspaces = [
                    row
                    for row in self.db.open_table("workspaces").to_arrow().to_pylist()
                    if row["name"] == name
                ]
                self.assertEqual([r["id"] for r in workspaces], [entry["workspace_id"]])
                peers = self.rows("peers", name)
                self.assertEqual(sorted(r["name"] for r in peers), sorted(entry["peer_names"]))
                messages = self.rows("messages", name)
                self.assertEqual(
                    [r["public_id"] for r in messages], [entry["message_public_id"]]
                )
                self.assertEqual([r["session_name"] for r in messages], [entry["session_name"]])
                traces = self.rows("traces", name)
                self.assertEqual([r["id"] for r in traces], [entry["trace_id"]])
                terms = {r["id"]: r for r in self.rows("terms", name)}
                for vocabulary, seeded in entry["term_ids"].items():
                    for term in seeded.values():
                        self.assertIn(term["id"], terms)
                        self.assertEqual(terms[term["id"]]["name"], term["name"])
                        self.assertEqual(terms[term["id"]]["is_active"], term["is_active"])
                        self.assertEqual(
                            terms[term["id"]]["vocabulary_id"],
                            entry["vocabulary_ids"][vocabulary],
                        )

    def test_message_legacy_integer_ids_are_distinct_across_workspaces(self):
        ids = [r["id"] for r in self.db.open_table("messages").to_arrow().to_pylist()]
        self.assertEqual(len(ids), len(set(ids)))

    def rows(self, table: str, workspace: str) -> list:
        return [
            row
            for row in self.db.open_table(table).to_arrow().to_pylist()
            if row["workspace_name"] == workspace
        ]

    def collect_ids(self, workspace: str) -> set:
        entry = self.ids[workspace]
        values = {entry["workspace_id"], entry["message_public_id"], entry["trace_id"]}
        values |= set(entry["vocabulary_ids"].values())
        values |= {
            term["id"] for terms in entry["term_ids"].values() for term in terms.values()
        }
        return values


class DeterminismTests(unittest.TestCase):
    """Two runs must produce the same dataset, not merely a valid one."""

    def test_two_independent_runs_return_identical_identities(self):
        results = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "publication-v1-lancedb"
                root.mkdir()
                results.append(
                    create_publication_fixture(
                        str(root), workspaces=["alpha-workspace", "beta-workspace"]
                    )
                )
        self.assertEqual(results[0], results[1])


class InputValidationTests(unittest.TestCase):
    """Workspace names are the caller's, but they still have to be usable."""

    def test_rejects_empty_blank_and_duplicate_workspace_lists(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "publication-v1-lancedb"
            root.mkdir()
            for bad in ([], ["   "], ["dup", "dup"], ["ok", 7]):
                with self.subTest(workspaces=bad), self.assertRaises(ValueError):
                    create_publication_fixture(str(root), workspaces=bad)
            # A non-list is a caller TYPE error, not a bad value.
            with self.assertRaises(TypeError):
                create_publication_fixture(str(root), workspaces="alpha-workspace")
            # A rejected call must not have left a dataset behind.
            self.assertEqual(all_table_names(lancedb.connect(str(root))), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
