"""Physical schema gates for the ISOLATED target-19 candidate.

What these tests prove: the candidate declares exactly 19 tables with a
reviewed, checked-in physical Arrow shape; drift against that shape is rejected
before any write; and representative rows survive a LanceDB round trip.

What they deliberately do NOT prove: canonical revision bytes, digest
correctness, publication/concurrency, or any uniqueness invariant. Those are
service gates (#26 onward), not physical schema facts.
"""

import ast
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

import lancedb
import pyarrow as pa
from arra_migrate.contract_v1 import format_int64, parse_int64, parse_timestamp
from arra_migrate.models import TABLES as ACTIVE_TABLES
from arra_migrate.target_v1 import (
    ADDED_TARGET_TABLES,
    REPLACED_ACTIVE_TABLES,
    TARGET_REGISTRY_VERSION,
    TARGET_TABLE_NAMES,
    TARGET_TABLES,
)
from arra_migrate.target_v1.schema import (
    SchemaDriftError,
    assert_schema_matches,
    describe_schema,
    describe_type,
    diff_described,
    open_table_checked,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "target-v1"
GOLDEN = json.loads((FIXTURES / "golden-schema.json").read_text(encoding="utf-8"))
SAMPLES = json.loads((FIXTURES / "sample-rows.json").read_text(encoding="utf-8"))

# sha256 of GOLDEN["provenance"]. Update deliberately, never mechanically.
PROVENANCE_DIGEST = "3cf03a3cbc99bc35984f20dd35f41b84ff9916d8ba0a130baddc75bdfb42351c"

# The literal expected target, written out here on purpose. Asserting against
# this tuple -- not against len(...) == 19 and not against the generic
# validate_target_manifest() check -- is what makes a silent rename visible.
EXPECTED_TARGET_19 = (
    "workspaces", "peers", "sessions", "session_peers", "messages",
    "session_links",
    "nodes", "node_revisions", "node_revision_terms", "revision_links", "supersede_log",
    "vocabularies", "terms",
    "traces", "trace_hits",
    "search_chunks_v1",
    "mcp_calls", "connections", "read_cursors",
)

EXPECTED_ACTIVE_15 = (
    "workspaces", "peers", "sessions", "session_peers", "messages",
    "memories", "vocabularies", "terms", "memory_terms", "supersede_log",
    "traces", "trace_hits", "mcp_calls", "connections", "read_cursors",
)


class RegistryTests(unittest.TestCase):
    """Gate A: exact 19, and the active registry left alone."""

    def test_target_is_the_literal_ordered_nineteen(self):
        self.assertEqual(TARGET_TABLE_NAMES, EXPECTED_TARGET_19)
        self.assertEqual(len(set(TARGET_TABLE_NAMES)), 19)
        self.assertEqual(tuple(TARGET_TABLES), EXPECTED_TARGET_19)
        self.assertEqual(TARGET_REGISTRY_VERSION, "arra-v4-target/1")

    def test_target_is_active15_minus_two_plus_six(self):
        active = set(EXPECTED_ACTIVE_15)
        self.assertEqual(set(ACTIVE_TABLES), active)
        self.assertEqual(REPLACED_ACTIVE_TABLES, ("memories", "memory_terms"))
        self.assertEqual(
            ADDED_TARGET_TABLES,
            ("session_links", "nodes", "node_revisions", "node_revision_terms", "revision_links", "search_chunks_v1"),
        )
        computed = (active - set(REPLACED_ACTIVE_TABLES)) | set(ADDED_TARGET_TABLES)
        self.assertEqual(computed, set(EXPECTED_TARGET_19))
        self.assertEqual(len(active) - 2 + 6, 19)
        # The replaced legacy tables must be gone from the target, not merely
        # outnumbered by the additions.
        for legacy in REPLACED_ACTIVE_TABLES:
            self.assertNotIn(legacy, TARGET_TABLE_NAMES)

    def test_active_registry_is_untouched_by_the_candidate(self):
        self.assertEqual(len(ACTIVE_TABLES), 15)
        self.assertEqual(tuple(ACTIVE_TABLES), EXPECTED_ACTIVE_15)
        # Same table name in both registries does not mean same shape: the
        # target adds [P] columns. Prove the ACTIVE shape did not move by
        # checking a column the candidate adds is absent from the active model.
        self.assertNotIn("ingested_at", ACTIVE_TABLES["messages"].model_fields)
        self.assertNotIn("workspace_name", ACTIVE_TABLES["read_cursors"].model_fields)
        self.assertIn("ingested_at", TARGET_TABLES["messages"].model_fields)
        self.assertIn("workspace_name", TARGET_TABLES["read_cursors"].model_fields)


class GoldenSchemaTests(unittest.TestCase):
    """Gate A/B: the checked-in golden, never regenerated during a test run."""

    def test_golden_covers_exactly_the_nineteen_in_order(self):
        self.assertEqual(tuple(GOLDEN["tables"]), EXPECTED_TARGET_19)
        self.assertEqual(GOLDEN["registry_version"], TARGET_REGISTRY_VERSION)
        self.assertEqual(GOLDEN["status"], "proposed-not-active")
        # The golden must state the SCOPE of its approval, not just that it
        # has one: independent review cleared the physical field/schema shape,
        # not canonicalization, service invariants, runtime activation, or #23.
        #
        # PINNED BY DIGEST, not by substring. An earlier version used assertIn
        # for each disclaimer, which is APPEND-BLIND -- an audit showed that
        # adding "service invariants are now ALSO proven and #23 is ACCEPTED"
        # while leaving all four disclaimers intact kept every test green. A
        # digest fails on any edit, so widening the claim has to be deliberate
        # and shows up as a changed constant in the diff.
        provenance = GOLDEN["provenance"]
        self.assertEqual(hashlib.sha256(provenance.encode("utf-8")).hexdigest(), PROVENANCE_DIGEST)
        # Kept as readable documentation of what the digest is protecting.
        self.assertIn("PHYSICAL FIELD / SCHEMA review is APPROVED", provenance)
        for excluded in ("NOT approval of canonicalization", "NOT of any service", "NOT of runtime activation", "NOT acceptance of issue #23"):
            self.assertIn(excluded, provenance)

    def test_models_match_the_golden_field_for_field(self):
        for name in EXPECTED_TARGET_19:
            with self.subTest(table=name):
                described = describe_schema(TARGET_TABLES[name].to_arrow_schema())
                expected = [list(f) for f in GOLDEN["tables"][name]]
                self.assertEqual(described, expected)

    def test_golden_pins_the_decisions_that_matter(self):
        columns = {t: {f[0]: (f[1], f[2]) for f in GOLDEN["tables"][t]} for t in GOLDEN["tables"]}
        # Legacy epoch-millisecond columns stay Int64. Converting them silently
        # is exactly what DESIGN.md section 4 forbids.
        for table, field in [
            ("traces", "session_from_ts"), ("traces", "session_to_ts"),
            ("traces", "created_at"), ("traces", "updated_at"),
            ("mcp_calls", "created_at"),
        ]:
            self.assertEqual(columns[table][field][0], "int64", f"{table}.{field} must stay Int64")
        # Every other time column is timestamp[us] with NO timezone.
        for table, fields in columns.items():
            for field, (dtype, _) in fields.items():
                if dtype.startswith("timestamp"):
                    self.assertEqual(dtype, "timestamp[us]", f"{table}.{field}")
        # Association snapshots are REQUIRED; empty is "[]", never NULL.
        for field in ("term_snapshot_json", "link_snapshot_json", "canonical_version", "content_digest"):
            self.assertEqual(columns["node_revisions"][field], ("utf8", False))
        # revision_no is a required Int64 ordinal. No uniqueness claim here.
        self.assertEqual(columns["node_revisions"]["revision_no"], ("int64", False))
        # The singular distilled pointer does NOT survive into the target:
        # section 10 replaces it with revision_links, and a compatibility
        # display must be derived from those, not stored a second time.
        self.assertNotIn("distilled_to", columns["traces"])
        self.assertNotIn("distilled_at", columns["traces"])
        # The active registry keeps its legacy pair, untouched.
        self.assertIn("distilled_to", ACTIVE_TABLES["traces"].model_fields)
        self.assertIn("distilled_at", ACTIVE_TABLES["traces"].model_fields)
        # Derived projections carry no independent id column.
        self.assertNotIn("id", columns["revision_links"])
        self.assertNotIn("id", columns["node_revision_terms"])
        # search_chunks_v1 physical shape.
        self.assertEqual(columns["search_chunks_v1"]["embedding"], ("fixed_size_list<float32?>[384]", True))
        self.assertEqual(columns["search_chunks_v1"]["term_ids"], ("list<utf8?>", False))
        # Exactly-one-type (section 7) means the copied type is never absent.
        # `status` already carries staging, so no nullable exception is owed.
        self.assertEqual(columns["search_chunks_v1"]["type_term_id"], ("utf8", False))
        # A trace hit carries a structured locator, not only its display ref.
        self.assertEqual(columns["trace_hits"]["target"], ("utf8", False))
        for field in ("excerpt", "content_hash"):
            self.assertEqual(columns["trace_hits"][field], ("utf8", True))
        self.assertEqual(columns["trace_hits"]["captured_at"], ("timestamp[us]", True))
        # Every scoped table names its workspace explicitly.
        for table, fields in columns.items():
            if table != "workspaces":
                self.assertIn("workspace_name", fields, f"{table} must be explicitly scoped")


class DescribeTypeTests(unittest.TestCase):
    """Large variants are distinct types, not synonyms."""

    def test_large_variants_render_distinctly(self):
        self.assertEqual(describe_type(pa.string()), "utf8")
        self.assertEqual(describe_type(pa.large_string()), "large_utf8")
        self.assertEqual(describe_type(pa.list_(pa.string())), "list<utf8?>")
        self.assertEqual(describe_type(pa.large_list(pa.string())), "large_list<utf8?>")
        self.assertEqual(describe_type(pa.list_(pa.float32(), 384)), "fixed_size_list<float32?>[384]")
        self.assertEqual(describe_type(pa.timestamp("us")), "timestamp[us]")
        self.assertEqual(describe_type(pa.timestamp("us", tz="UTC")), "timestamp[us,UTC]")


class DriftRejectionTests(unittest.TestCase):
    """Gate C: every incompatible physical change is reported, in PyArrow."""

    BASE = pa.schema([
        pa.field("id", pa.string(), nullable=False),
        pa.field("seq", pa.int64(), nullable=False),
        pa.field("created_at", pa.timestamp("us"), nullable=False),
        pa.field("term_ids", pa.list_(pa.string()), nullable=False),
        pa.field("embedding", pa.list_(pa.float32(), 384), nullable=True),
    ])

    def expected(self):
        return describe_schema(self.BASE)

    def assert_rejects(self, label, schema, fragment):
        with self.subTest(drift=label):
            with self.assertRaises(SchemaDriftError) as caught:
                assert_schema_matches("t", self.expected(), schema)
            self.assertTrue(
                any(fragment in problem for problem in caught.exception.problems),
                f"{label}: {fragment!r} not in {caught.exception.problems}",
            )

    def test_identical_schema_is_accepted(self):
        assert_schema_matches("t", self.expected(), self.BASE)
        self.assertEqual(diff_described(self.expected(), describe_schema(self.BASE)), [])

    def test_every_incompatible_change_is_rejected(self):
        fields = list(self.BASE)
        cases = [
            ("missing field", pa.schema(fields[:-1]), "missing field 'embedding'"),
            ("extra field", pa.schema([*fields, pa.field("surprise", pa.string())]), "unexpected field 'surprise'"),
            ("int width int64->int32", pa.schema([f if f.name != "seq" else pa.field("seq", pa.int32(), nullable=False) for f in fields]), "type 'int32'"),
            ("required->nullable", pa.schema([f if f.name != "id" else pa.field("id", pa.string(), nullable=True) for f in fields]), "nullable=True"),
            ("nullable->required", pa.schema([f if f.name != "embedding" else pa.field("embedding", pa.list_(pa.float32(), 384), nullable=False) for f in fields]), "nullable=False"),
            ("timestamp unit us->ms", pa.schema([f if f.name != "created_at" else pa.field("created_at", pa.timestamp("ms"), nullable=False) for f in fields]), "timestamp[ms]"),
            ("timestamp gains a timezone", pa.schema([f if f.name != "created_at" else pa.field("created_at", pa.timestamp("us", tz="UTC"), nullable=False) for f in fields]), "timestamp[us,UTC]"),
            ("vector element float32->float64", pa.schema([f if f.name != "embedding" else pa.field("embedding", pa.list_(pa.float64(), 384), nullable=True) for f in fields]), "fixed_size_list<float64?>[384]"),
            ("vector dimension 384->768", pa.schema([f if f.name != "embedding" else pa.field("embedding", pa.list_(pa.float32(), 768), nullable=True) for f in fields]), "[768]"),
            # Offset-width drift. The first draft of describe_type() collapsed
            # both of these into the small variant and ACCEPTED them; found by
            # independent review 2026-09-20.
            ("utf8->large_utf8", pa.schema([f if f.name != "id" else pa.field("id", pa.large_string(), nullable=False) for f in fields]), "large_utf8"),
            ("list->large_list", pa.schema([f if f.name != "term_ids" else pa.field("term_ids", pa.large_list(pa.string()), nullable=False) for f in fields]), "large_list<utf8?>"),
            ("list element nullability", pa.schema([f if f.name != "term_ids" else pa.field("term_ids", pa.list_(pa.field("item", pa.string(), nullable=False)), nullable=False) for f in fields]), "list<utf8>"),
            ("field order swapped", pa.schema([fields[1], fields[0], *fields[2:]]), "field order"),
        ]
        for label, schema, fragment in cases:
            self.assert_rejects(label, schema, fragment)

    def test_combined_drift_reports_every_change_including_order(self):
        # An earlier version gated the order check on "no other problem", so a
        # reorder arriving alongside a type change was silently dropped from
        # the report. Found by adversarial audit 2026-09-20.
        fields = list(self.BASE)
        swapped_and_retyped = pa.schema([
            pa.field("seq", pa.int32(), nullable=False),   # reordered AND retyped
            fields[0], *fields[2:],
        ])
        problems = diff_described(self.expected(), describe_schema(swapped_and_retyped))
        self.assertTrue(any("type 'int32'" in p for p in problems), problems)
        self.assertTrue(any("field order" in p for p in problems), problems)

    def test_order_is_not_reported_when_names_differ(self):
        # With a missing field the order line would restate the missing line.
        fields = list(self.BASE)
        problems = diff_described(self.expected(), describe_schema(pa.schema(fields[:-1])))
        self.assertTrue(any("missing field" in p for p in problems), problems)
        self.assertFalse(any("field order" in p for p in problems), problems)

    def test_field_order_change_alone_is_drift(self):
        fields = list(self.BASE)
        swapped = pa.schema([fields[1], fields[0], *fields[2:]])
        problems = diff_described(self.expected(), describe_schema(swapped))
        self.assertEqual(len(problems), 1)
        self.assertIn("field order", problems[0])


class PersistedDriftTests(unittest.TestCase):
    """Gate C: the same rejection against REAL persisted LanceDB tables.

    Measures schema, dataset version and row count before and after the
    rejected operation, so "it raised" is backed by "and it changed nothing".
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="arra-target-drift-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.db = lancedb.connect(str(self.root / "db"))

    def _state(self, name):
        handle = self.db.open_table(name)
        return describe_schema(handle.schema), handle.version, handle.count_rows()

    def test_wrong_persisted_tables_are_rejected_and_left_unchanged(self):
        """One mutation per case, so the rejection is EXACTLY determined.

        An earlier version compared 2-column stubs against the 20-column
        search_chunks_v1 golden, so each table was rejected by 18 unrelated
        `missing field` problems and the named drift merely rode along. Each
        case below is now the full golden schema with a single column changed,
        and the test asserts the problem count is exactly one.
        """
        expected = [list(f) for f in GOLDEN["tables"]["search_chunks_v1"]]
        cases = [
            ("wrong_int_width", "chunk_index", pa.int32(), False, "chunk_index: type 'int32' != expected 'int64'"),
            ("wrong_vector_dim", "embedding", pa.list_(pa.float32(), 768), True, "embedding: type 'fixed_size_list<float32?>[768]' != expected 'fixed_size_list<float32?>[384]'"),
            ("wrong_vector_elem", "embedding", pa.list_(pa.float64(), 384), True, "embedding: type 'fixed_size_list<float64?>[384]' != expected 'fixed_size_list<float32?>[384]'"),
            ("large_utf8_offsets", "text", pa.large_string(), False, "text: type 'large_utf8' != expected 'utf8'"),
            ("large_list_offsets", "term_ids", pa.large_list(pa.string()), False, "term_ids: type 'large_list<utf8?>' != expected 'list<utf8?>'"),
            ("nullable_flip", "type_term_id", pa.string(), True, "type_term_id: nullable=True != expected False"),
            ("timestamp_unit", "embedded_at", pa.timestamp("ms"), True, "embedded_at: type 'timestamp[ms]' != expected 'timestamp[us]'"),
            ("timestamp_tz", "embedded_at", pa.timestamp("us", tz="UTC"), True, "embedded_at: type 'timestamp[us,UTC]' != expected 'timestamp[us]'"),
        ]
        base = TARGET_TABLES["search_chunks_v1"].to_arrow_schema()
        for name, column, dtype, nullable, message in cases:
            with self.subTest(table=name):
                mutated = pa.schema([
                    pa.field(column, dtype, nullable=nullable) if f.name == column else f
                    for f in base
                ])
                table = self.db.create_table(name, schema=mutated)
                table.add(pa.table({f.name: _placeholder(f.type) for f in mutated}, schema=mutated))
                before = self._state(name)
                self.assertEqual(before[2], 1)

                with self.assertRaises(SchemaDriftError) as caught:
                    open_table_checked(self.db, name, expected)
                # EXACTLY one problem, and it is the one the case is named for.
                self.assertEqual(caught.exception.problems, [message])

                after = self._state(name)
                self.assertEqual(before, after, "a rejected open must not touch schema, version or rows")

    def test_a_full_fidelity_persisted_table_opens(self):
        """Positive control for the SAME 20-column table the drift cases mutate."""
        expected = [list(f) for f in GOLDEN["tables"]["search_chunks_v1"]]
        model = TARGET_TABLES["search_chunks_v1"]
        table = self.db.create_table("search_chunks_v1", schema=model)
        table.add([_build(model, row) for row in SAMPLES["tables"]["search_chunks_v1"]])
        handle = open_table_checked(self.db, "search_chunks_v1", expected)
        self.assertEqual(handle.count_rows(), 2)

    def test_a_correct_persisted_table_opens(self):
        model = TARGET_TABLES["read_cursors"]
        expected = [list(f) for f in GOLDEN["tables"]["read_cursors"]]
        self.db.create_table("read_cursors", schema=model)
        handle = open_table_checked(self.db, "read_cursors", expected)
        self.assertEqual(handle.count_rows(), 0)


def _placeholder(dtype):
    if pa.types.is_boolean(dtype):
        return pa.array([True], type=dtype)
    if pa.types.is_timestamp(dtype):
        return pa.array([0], type=pa.int64()).cast(dtype)
    if pa.types.is_floating(dtype):
        return pa.array([0.0], type=dtype)
    if pa.types.is_integer(dtype):
        return pa.array([1], type=dtype)
    if pa.types.is_fixed_size_list(dtype):
        return pa.array([[0.0] * dtype.list_size], type=dtype)
    if pa.types.is_large_list(dtype) or pa.types.is_list(dtype):
        return pa.array([["x"]], type=dtype)
    return pa.array(["x"], type=dtype)


class RoundTripTests(unittest.TestCase):
    """Gate D: representative rows survive Python -> LanceDB -> Python."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="arra-target-roundtrip-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.db = lancedb.connect(str(self.root / "db"))

    def test_int64_beyond_js_safe_range_survives(self):
        model = TARGET_TABLES["messages"]
        sample = SAMPLES["tables"]["messages"]
        rows = [_build(model, row) for row in sample]
        table = self.db.create_table("messages", schema=model)
        table.add(rows)
        back = {r["public_id"]: r for r in self.db.open_table("messages").to_arrow().to_pylist()}
        big = back[sample[0]["public_id"]]
        small = back[sample[1]["public_id"]]
        self.assertEqual(format_int64(big["id"]), "9223372036854775807")
        self.assertEqual(format_int64(small["id"]), "-9223372036854775808")
        self.assertGreater(big["id"], 2**53)  # past JS Number precision
        self.assertEqual(big["content"], sample[0]["content"])
        self.assertIn("ความทรงจำ", big["content"])
        # source time and ingestion time are distinct columns with distinct values
        self.assertNotEqual(big["source_created_at"], big["ingested_at"])
        self.assertIsNone(small["source_created_at"])
        self.assertIsNotNone(small["ingested_at"])

    def test_vector_null_and_finite_384_both_round_trip(self):
        model = TARGET_TABLES["search_chunks_v1"]
        sample = SAMPLES["tables"]["search_chunks_v1"]
        table = self.db.create_table("search_chunks_v1", schema=model)
        table.add([_build(model, row) for row in sample])
        back = {r["id"]: r for r in self.db.open_table("search_chunks_v1").to_arrow().to_pylist()}
        empty = back[sample[0]["id"]]
        filled = back[sample[1]["id"]]
        self.assertIsNone(empty["embedding"])
        self.assertEqual(empty["term_ids"], [])       # empty list, not NULL
        self.assertEqual(empty["status"], "pending")
        self.assertEqual(len(filled["embedding"]), 384)
        self.assertEqual(filled["embedding"], sample[1]["embedding"])  # exact, float32-representable
        self.assertEqual(filled["term_ids"], sample[1]["term_ids"])
        self.assertEqual(filled["text"], "ภาษาไทย 🌱 body")

    def test_empty_association_snapshots_are_the_string_bracket_pair(self):
        model = TARGET_TABLES["node_revisions"]
        sample = SAMPLES["tables"]["node_revisions"]
        table = self.db.create_table("node_revisions", schema=model)
        table.add([_build(model, row) for row in sample])
        back = {r["id"]: r for r in self.db.open_table("node_revisions").to_arrow().to_pylist()}
        empty = back[sample[0]["id"]]
        full = back[sample[1]["id"]]
        self.assertEqual(empty["term_snapshot_json"], "[]")
        self.assertEqual(empty["link_snapshot_json"], "[]")
        self.assertIsNotNone(empty["term_snapshot_json"])
        # Shape only: valid UTF-8 JSON arrays. NOT canonical bytes, NOT a digest check.
        for row in (empty, full):
            for field in ("term_snapshot_json", "link_snapshot_json"):
                parsed = json.loads(row[field])
                self.assertIsInstance(parsed, list)
                row[field].encode("utf-8")
        self.assertEqual(len(json.loads(full["term_snapshot_json"])), 1)
        self.assertEqual(full["title"], "แก้ไขความเข้าใจ")

    def test_two_physical_revisions_may_share_an_ordinal(self):
        # Two ROWS share ordinal 1. The fixture does not establish what
        # publication state either row is in -- R1 happens to be the node's
        # head and R2 is not, but neither fact is proven here, and no
        # accepted/prepared/orphan semantics are asserted. The only claim is
        # that the PHYSICAL schema permits the collision, because #26 owns
        # both the numbering rule and publication state.
        model = TARGET_TABLES["node_revisions"]
        sample = SAMPLES["tables"]["node_revisions"]
        self.assertEqual(sample[0]["revision_no"], sample[1]["revision_no"])
        table = self.db.create_table("node_revisions", schema=model)
        table.add([_build(model, row) for row in sample])
        rows = self.db.open_table("node_revisions").to_arrow().to_pylist()
        self.assertEqual([r["revision_no"] for r in rows], [1, 1])

    def test_all_nineteen_persist_with_the_golden_schema(self):
        for name in EXPECTED_TARGET_19:
            with self.subTest(table=name):
                model = TARGET_TABLES[name]
                table = self.db.create_table(name, schema=model)
                table.add([_build(model, row) for row in SAMPLES["tables"][name]])
                reopened = self.db.open_table(name)
                self.assertEqual(describe_schema(reopened.schema), [list(f) for f in GOLDEN["tables"][name]])
                self.assertEqual(reopened.count_rows(), len(SAMPLES["tables"][name]))


class IsolationTests(unittest.TestCase):
    """Gate F evidence: bounded observations that the candidate stays isolated.

    Read the individual docstrings for exactly what each test covers -- none of
    them is a universal no-side-effects proof, and the class does not claim to
    be one. Together they give: a behavioural import probe scoped to a scratch
    directory and patched sockets, a syntactic lint over top-level module
    statements, and a recursive check that the migrator never imports the
    candidate.

    All three were rewritten after an adversarial audit showed the first
    versions could pass without checking anything. The substring denylist they
    replace missed os.getenv, file writes, mkdir, subprocess, sockets and an
    aliased `lancedb.connect`; the migrator scan was non-recursive and returned
    silently empty if its path ever stopped resolving.
    """

    SOURCE_ROOT = Path(__file__).resolve().parents[1] / "src" / "arra_migrate"

    def test_the_source_root_resolves(self):
        # A floor, so no guard in this class can pass by scanning nothing.
        self.assertTrue(self.SOURCE_ROOT.is_dir(), f"{self.SOURCE_ROOT} must exist")
        self.assertGreaterEqual(len(list(self.SOURCE_ROOT.rglob("*.py"))), 25)

    def test_importing_the_candidate_writes_nothing_and_opens_no_connection(self):
        """Import it for real in a clean subprocess and observe what happens.

        Precisely what is asserted, and nothing broader:
          - no call to the PATCHED `socket.socket.connect`, `connect_ex` or
            `socket.create_connection` was attempted. Other paths to the
            network (a C extension holding its own descriptor, an fd passed in,
            a subprocess) are NOT covered.
          - no entries appeared in the scratch directory used as CWD, HOME and
            TMPDIR. Writes to an absolute path elsewhere are NOT covered --
            this is a scratch-directory observation, not a sandbox.
          - `arra_migrate.models` was not imported behind the candidate.
          - the import succeeded and the registry holds 19 tables.

        This is evidence about one import under one set of probes. It is not a
        claim that the package has no side effects of any kind.
        """
        scratch = Path(tempfile.mkdtemp(prefix="arra-import-probe-"))
        self.addCleanup(shutil.rmtree, scratch, ignore_errors=True)
        probe = textwrap.dedent(
            """
            import json, socket, sys

            def _refuse(*args, **kwargs):
                raise AssertionError("candidate import attempted a patched socket connection")

            # Patch the METHODS, not the socket class: `ssl` subclasses
            # socket.socket at import time, so replacing the class breaks the
            # stdlib rather than the thing under test. Importing urllib/ssl is
            # a dependency's business; actually CONNECTING is what we forbid.
            socket.socket.connect = _refuse
            socket.socket.connect_ex = _refuse
            socket.create_connection = _refuse

            before = set(sys.modules)
            import arra_migrate.target_v1 as candidate
            pulled = sorted(m for m in set(sys.modules) - before if m.startswith("arra_migrate"))
            print(json.dumps({
                "tables": len(candidate.TARGET_TABLES),
                "arra_modules": pulled,
            }))
            """
        )
        result = subprocess.run(
            [sys.executable, "-c", probe],
            cwd=scratch,
            env={
                "PYTHONPATH": str(self.SOURCE_ROOT.parent),
                "PATH": os.environ.get("PATH", ""),
                "HOME": str(scratch),
                "TMPDIR": str(scratch),
            },
            capture_output=True,
            text=True,
            timeout=120,
            check=False,   # the return code IS the assertion below
        )
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        report = json.loads(result.stdout)
        self.assertEqual(report["tables"], 19)
        # No entry appeared in the scratch dir serving as CWD, HOME and TMPDIR.
        # Scoped to that directory -- not a claim about the whole filesystem.
        self.assertEqual(sorted(p.name for p in scratch.iterdir()), [])
        # The candidate must not drag the ACTIVE registry in behind it.
        self.assertNotIn("arra_migrate.models", report["arra_modules"])

    def test_no_call_appears_in_top_level_module_statements(self):
        """No call appears in the candidate's TOP-LEVEL module statements.

        Deliberately narrow, and narrower than an earlier version of this test
        claimed. What is inspected: statements directly in `module.body` that
        are NOT a ClassDef or FunctionDef -- assignments, imports, bare
        expressions. Parsed rather than grepped, so within that subset a call
        is seen whether it is spelled directly, through an import alias, or
        through a rebound name.

        EXPLICITLY NOT INSPECTED, each of which can evaluate at import time:
          - class bodies. `search.py:24` really does evaluate
            `Vector(EMBEDDING_DIM_V1)` at import, inside `SearchChunkV1`'s
            annotations; that is intended and this test does not cover it.
          - decorators, base-class expressions, and metaclass keywords.
          - default arguments and annotation expressions on def statements.
          - function bodies (which do NOT run at import, but are skipped here
            regardless -- see the subprocess probe for import-time behaviour).

        So this is a lint over one syntactic region, NOT proof that the package
        performs no work on import. The subprocess probe above is the
        behavioural evidence; the two are complementary and neither alone is
        an import-time guarantee.
        """
        modules = sorted(self.SOURCE_ROOT.joinpath("target_v1").glob("*.py"))
        self.assertGreaterEqual(len(modules), 10)
        for path in modules:
            with self.subTest(module=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
                for node in tree.body:  # module scope only
                    for inner in ast.walk(node):
                        if isinstance(inner, ast.Call) and not isinstance(node, (ast.ClassDef, ast.FunctionDef)):
                            self.fail(f"{path.name}:{inner.lineno} calls at import time: {ast.dump(inner.func)[:80]}")

    def test_the_migrator_does_not_import_the_candidate(self):
        """Recursive, with a floor. The earlier version scanned two globs.

        ``rehearsal.py`` (issue #34) is excluded on purpose: it is the
        DELIBERATE, isolated consumer of the candidate -- a disposable-dataset
        rehearsal that reads the active-15 shape and writes the target-19
        shape, never wired into ``__main__`` and never touching
        ``ARRA_DATA_DIR``. What this test still guards is the thing that
        matters: the PRODUCTION migrator entrypoint (``__main__.py``) does not
        pull the unreviewed candidate into the path that creates real tables.

        ``copy_migration/`` (issue #34, overnight rulings R11 + R17) is
        excluded DELIBERATELY, as a whole package, for the same reason as
        ``rehearsal.py``: it is the operator-only copy migration, whose job is
        to create the 19 target tables in a NEW empty candidate directory under
        the writer gate. It has its own entry point (``arra-migrate-copy``),
        never touches ``ARRA_DATA_DIR`` and only reads a snapshot copy of the
        source. The exclusion is by directory, not by substring, and the two
        assertions after the loop keep the production entry point from
        reaching either the candidate or the copy path.
        """
        scanned = [
            p for p in self.SOURCE_ROOT.rglob("*.py")
            if "target_v1" not in p.parts and "copy_migration" not in p.parts and p.name != "rehearsal.py"
        ]
        # Floor: today that is 8 root modules + 17 models. If a reorg makes this
        # scan collapse, the assertion fails instead of the loop finding nothing.
        self.assertGreaterEqual(len(scanned), 25, f"only scanned {len(scanned)} modules")
        for path in scanned:
            with self.subTest(module=str(path.relative_to(self.SOURCE_ROOT))):
                self.assertNotIn("target_v1", path.read_text(encoding="utf-8"))
        self.assertNotIn(
            "target_v1",
            (self.SOURCE_ROOT / "__main__.py").read_text(encoding="utf-8"),
            "the real migrator entrypoint must still never import the candidate",
        )
        self.assertNotIn(
            "copy_migration",
            (self.SOURCE_ROOT / "__main__.py").read_text(encoding="utf-8"),
            "the real migrator entrypoint must never reach the #34 copy migration either",
        )


_DECLARED: dict[str, dict[str, str]] = {}


def _build(model, row):
    key = model.__name__
    if key not in _DECLARED:
        _DECLARED[key] = {name: dtype for name, dtype, _ in describe_schema(model.to_arrow_schema())}
    declared = _DECLARED[key]
    values = {}
    for name in model.model_fields:
        value = row[name]
        if value is None:
            values[name] = None
        elif declared[name].startswith("timestamp["):
            values[name] = parse_timestamp(value).replace(tzinfo=None)
        elif declared[name] == "int64":
            values[name] = parse_int64(value)
        else:
            values[name] = value
    return model(**values)


if __name__ == "__main__":
    unittest.main()
