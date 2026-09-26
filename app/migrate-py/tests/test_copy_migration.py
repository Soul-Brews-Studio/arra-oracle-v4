"""#34 copy migration on a realistic legacy-15 fixture (rulings R11 + R17).

Every test here runs against a fresh ``mktemp -d`` tree: a legacy source built
by ``tests/export_legacy_fixture.py``, an EMPTY candidate directory, and an
empty work directory. The Bun knowledge worker writes nodes/revisions through
the real publication kernel inside the candidate's writer gate; no model, no
network, no running service.

What this proves:
  - the ORIGINAL source tree is byte-identical before and after (sha256 per
    file), and the migration only ever read a snapshot copy;
  - rows_in == migrated + rejected + unresolved for all 15 source tables,
    memories and memory_terms included, with a per-record entry for each;
  - the candidate is exactly the reviewed target-19 physical shape;
  - memories became nodes with an accepted first revision (Thai text intact),
    legacy types follow R11, memory_terms became node_revision_terms, supersede
    rows follow R17, distilled_at lands in internal metadata, not captured_at;
  - the TS kernel reads every migrated node back and every stored row passes
    the TS stored-row codecs;
  - the inherited release gates #7/#8/#10 are named as EXCLUDED, never green.

What it does not prove: production cutover, R2, or recall quality.
"""

from __future__ import annotations

import base64
import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import lancedb

from arra_migrate.target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from arra_migrate.target_v1.schema import describe_schema

# The fixture builder is a sibling script, importable under both
# `unittest discover -s tests` and `python -m unittest tests.test_copy_migration`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_legacy_fixture import (
    LAB,
    MS0,
    SIDE,
    build_legacy_fixture,
    legacy_rows,
)

INTAKE_AT = "2026-09-26T14:00:00.000Z"


def _tree(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def _run(parent: Path, name: str):
    from arra_migrate.copy_migration import run_copy_migration

    candidate = parent / f"{name}-candidate"
    work = parent / f"{name}-work"
    candidate.mkdir()
    report = run_copy_migration(parent / "source", candidate, work, intake_at=INTAKE_AT)
    return report, candidate, work


def _rows(root: Path, table: str) -> list[dict]:
    return lancedb.connect(str(root)).open_table(table).to_arrow().to_pylist()


class CopyMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parent = Path(tempfile.mkdtemp(prefix="arra-copy-migration-"))
        build_legacy_fixture(cls.parent / "source")
        cls.tree_before = _tree(cls.parent / "source")
        cls.report, cls.candidate, cls.work = _run(cls.parent, "first")
        cls.tree_after = _tree(cls.parent / "source")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.parent, ignore_errors=True)

    # -- the source ---------------------------------------------------------

    def test_original_source_tree_is_byte_identical(self):
        self.assertEqual(self.tree_before, self.tree_after)
        source = self.report["source"]
        self.assertTrue(source["untouched"])
        self.assertEqual(source["tree_sha256_before"], source["tree_sha256_after"])
        # The migration read a COPY, never the original.
        self.assertNotEqual(Path(source["copy_root"]).resolve(), (self.parent / "source").resolve())

    # -- conservation -------------------------------------------------------

    def test_every_source_row_is_accounted_for_in_all_fifteen_tables(self):
        fixture = legacy_rows()
        tables = self.report["tables"]
        self.assertEqual(set(tables), set(fixture))
        for name, rows in fixture.items():
            with self.subTest(table=name):
                t = tables[name]
                self.assertEqual(t["rows_in"], len(rows))
                self.assertEqual(t["rows_in"], t["migrated"] + t["rejected"] + t["unresolved"])
                per_record = [r for r in self._records() if r["table"] == name]
                self.assertEqual(len(per_record), len(rows), "one record per source row")
        self.assertTrue(self.report["conservation_ok"])

    def test_memories_and_memory_terms_have_the_expected_outcomes(self):
        by_key = {(r["table"], r["legacy_key"]): r for r in self._records()}
        self.assertEqual(by_key[("memories", "m_muigr3dd_subms")]["outcome"], "rejected")
        self.assertEqual(by_key[("memories", "m_muigr3dd_subms")]["code"], "sub_millisecond_timestamp")
        migrated = [k for (t, k), r in by_key.items() if t == "memories" and r["outcome"] == "migrated"]
        self.assertEqual(len(migrated), 7)
        mt = {k: r for (t, k), r in by_key.items() if t == "memory_terms"}
        self.assertEqual(mt["m_muigr1bb_retro|term-orphan"]["outcome"], "unresolved")
        self.assertEqual(mt["m_muigr3dd_subms|term-oracle"]["outcome"], "rejected")
        self.assertEqual(mt["m_does_not_exist|term-oracle"]["outcome"], "unresolved")
        self.assertEqual(mt["m_muigqmxf_qchtyc|term-thai"]["outcome"], "migrated")

    def test_sub_millisecond_message_is_rejected_with_a_report_entry(self):
        record = next(r for r in self._records() if r["table"] == "messages" and r["legacy_key"] == "3")
        self.assertEqual(record["outcome"], "rejected")
        self.assertEqual(record["code"], "sub_millisecond_timestamp")
        self.assertEqual(record["pointer"], "/created_at")
        contents = [row["content"] for row in _rows(self.candidate, "messages")]
        self.assertNotIn("timestamp written by a microsecond clock", contents)
        self.assertIn("ingested_at=migration_intake;original_ingestion_unknown", self.report["assumptions"])

    def test_trace_hit_kind_outside_target_kinds_is_rejected_with_a_record(self):
        record = next(r for r in self._records() if r["table"] == "trace_hits")
        self.assertEqual((record["outcome"], record["code"]), ("rejected", "kind_outside_target_kinds"))
        self.assertEqual(_rows(self.candidate, "trace_hits"), [])

    def test_orphan_term_is_a_record_not_a_crash(self):
        record = next(r for r in self._records() if r["table"] == "terms" and r["legacy_key"] == "term-orphan")
        self.assertEqual(record["outcome"], "unresolved")
        self.assertEqual(record["code"], "vocabulary_unresolved")

    # -- the candidate shape ------------------------------------------------

    def test_candidate_is_exactly_the_target_nineteen(self):
        db = lancedb.connect(str(self.candidate))
        self.assertEqual(sorted(db.table_names(limit=1000)), sorted(TARGET_TABLE_NAMES))
        for name in TARGET_TABLE_NAMES:
            with self.subTest(table=name):
                self.assertEqual(
                    describe_schema(db.open_table(name).schema),
                    describe_schema(TARGET_TABLES[name].to_arrow_schema()),
                )
        self.assertEqual(self.report["candidate"]["schema_problems"], [])

    def test_legacy_ids_are_mapped_deterministically_to_nanoid21(self):
        peers = {r["name"]: r["id"] for r in _rows(self.candidate, "peers")}
        self.assertRegex(peers["nat"], r"^[A-Za-z0-9_-]{21}$")
        workspaces = {r["name"]: r["id"] for r in _rows(self.candidate, "workspaces")}
        self.assertEqual(workspaces[SIDE], "Sd0bAnkWorkspace00001", "a nanoid21 legacy id is preserved")
        id_map = [json.loads(line) for line in (self.work / "id_map.jsonl").read_text().splitlines()]
        self.assertTrue(any(e["legacy_id"] == "peer-nat" and e["target_id"] == peers["nat"] for e in id_map))
        messages = {r["content"]: r for r in _rows(self.candidate, "messages")}
        reply = messages["Check the drawer by the door."]
        original = messages["ลืมกุญแจไว้ที่บ้านอีกแล้ว"]
        self.assertEqual(reply["in_reply_to"], original["public_id"], "in_reply_to rewritten through the map")

    # -- knowledge: memories -> nodes/revisions -----------------------------

    def test_node_ids_use_the_r18_d1_legacy_node_derivation_byte_for_byte(self):
        """The v3-compat resolver finds a migrated memory by this exact formula."""

        def legacy_node_id(ws, legacy_id):
            digest = hashlib.sha256(f"arra-legacy-node/v1\n{ws}\n{legacy_id}".encode()).digest()
            return base64.urlsafe_b64encode(digest).decode("ascii")[:21]

        revisions = {r["node_id"]: r for r in _rows(self.candidate, "node_revisions")}
        for row in legacy_rows()["memories"]:
            if row["id"] == "m_muigr3dd_subms":
                continue
            with self.subTest(memory=row["id"]):
                node_id = legacy_node_id(row["workspace_name"], row["id"])
                self.assertIn(node_id, revisions)
                self.assertEqual(json.loads(revisions[node_id]["internal_metadata"])["legacy_id"], row["id"])

    def test_memories_become_nodes_with_an_accepted_first_revision(self):
        nodes = _rows(self.candidate, "nodes")
        revisions = {r["id"]: r for r in _rows(self.candidate, "node_revisions")}
        self.assertEqual(len(nodes), 7)
        for node in nodes:
            head = revisions[node["current_revision_id"]]
            self.assertEqual(head["revision_no"], 1)
            self.assertEqual(head["node_id"], node["id"])
        bodies = {r["title"]: r["body"] for r in revisions.values()}
        self.assertEqual(bodies["forgot-keys"], "ลืมกุญแจไว้ที่บ้าน ต้องวางไว้ข้างประตู")
        first = next(r for r in revisions.values() if r["title"] == "forgot-keys")
        meta = json.loads(first["internal_metadata"])
        self.assertEqual(meta["legacy_id"], "m_muigqmxf_qchtyc")
        self.assertEqual(meta["legacy_peer_name"], "nat")
        self.assertTrue(meta["attribution_unresolved"])
        self.assertEqual(meta["vector_disposition"], "rebuild_unknown_profile")
        self.assertIsNone(first["author_peer_name"])
        self.assertIsNone(first["observer_peer_name"])
        # created_at is the LEGACY time, not the migration clock.
        self.assertEqual(first["created_at"].isoformat(timespec="milliseconds"), "2026-09-20T08:50:00.123")

    def test_r11_reserved_type_kept_unknown_type_is_note_plus_original_tag(self):
        revisions = {r["title"]: r for r in _rows(self.candidate, "node_revisions")}

        def snapshot(title):
            return {(t["vocabulary_name_snapshot"], t["term_name_snapshot"])
                    for t in json.loads(revisions[title]["term_snapshot_json"])}

        self.assertIn(("type", "learning"), snapshot("keys-by-the-door"))
        self.assertIn(("type", "conclusion"), snapshot("new-conclusion"))
        self.assertEqual({v for v, _ in snapshot("retro-2026-09-19") if v == "type"}, {"type"})
        self.assertIn(("type", "note"), snapshot("retro-2026-09-19"))
        self.assertIn(("legacy_type", "retro"), snapshot("retro-2026-09-19"))
        self.assertIn(("legacy_type", "Decision Log"), snapshot("decision-log"))
        vocab = next(v for v in _rows(self.candidate, "vocabularies")
                     if v["name"] == "legacy_type" and v["workspace_name"] == LAB)
        self.assertEqual((vocab["cardinality"], vocab["required"], vocab["hierarchy"]), ("many", False, "flat"))

    def test_memory_terms_become_node_revision_terms(self):
        revisions = {r["id"]: r["title"] for r in _rows(self.candidate, "node_revisions")}
        projected = {(revisions[r["revision_id"]], r["term_name_snapshot"])
                     for r in _rows(self.candidate, "node_revision_terms")}
        self.assertIn(("forgot-keys", "oracle"), projected)
        self.assertIn(("forgot-keys", "ภาษาไทย"), projected)
        self.assertIn(("keys-by-the-door", "oracle"), projected)
        self.assertIn(("side-correction", "v4"), projected)

    def test_r17_legacy_vocabularies_are_many_optional_flat(self):
        topic = next(v for v in _rows(self.candidate, "vocabularies") if v["name"] == "topic")
        self.assertEqual((topic["cardinality"], topic["required"], topic["hierarchy"]), ("many", False, "flat"))
        clash = next(r for r in self._records() if r["table"] == "vocabularies" and r["legacy_key"] == "vocab-legacy-type")
        self.assertEqual((clash["outcome"], clash["code"]), ("rejected", "reserved_vocabulary_name"))

    def test_r17_null_supersede_reason_is_backfilled_and_counted(self):
        log = _rows(self.candidate, "supersede_log")
        reasons = sorted(r["reason"] for r in log)
        self.assertEqual(reasons, sorted(["moved the keys", "legacy: reason not recorded",
                                          "superseded by the ngram ruling"]))
        self.assertEqual(self.report["policies"]["null_reason_backfilled"], 1)
        missing = next(r for r in self._records() if r["table"] == "supersede_log" and r["legacy_key"] == "4")
        self.assertEqual(missing["outcome"], "unresolved")
        retire = next(r for r in log if r["reason"] == "superseded by the ngram ruling")
        self.assertIsNone(retire["new_id"])

    def test_distilled_to_becomes_trace_link_and_distilled_at_stays_internal(self):
        revisions = {r["title"]: r for r in _rows(self.candidate, "node_revisions")}
        target = revisions["new-conclusion"]
        links = json.loads(target["link_snapshot_json"])
        self.assertEqual(len(links), 1)
        self.assertEqual((links[0]["relation"], links[0]["target_kind"]), ("derived_from", "trace"))
        self.assertIsNone(links[0]["captured_at"], "distilled_at is never invented as captured_at")
        meta = json.loads(target["internal_metadata"])
        self.assertEqual(meta["legacy_distilled"][0]["distilled_at_ms"], str(MS0 + 36 * 60_000))
        projected = [r for r in _rows(self.candidate, "revision_links") if r["revision_id"] == target["id"]]
        self.assertEqual([r["target_kind"] for r in projected], ["trace"])
        dangling = next(r for r in self._records()
                        if r["table"] == "traces.distilled_to" and r["legacy_key"] == "trace-002")
        self.assertEqual(dangling["outcome"], "unresolved")

    def test_legacy_trace_status_is_mapped_into_the_kernel_closed_set_and_reported(self):
        statuses = {r["name"]: r["status"] for r in _rows(self.candidate, "traces")}
        self.assertEqual(statuses, {"0900_keys-hunt": "complete", "0910_keys-followup": "complete"})
        record = next(r for r in self._records() if r["table"] == "traces" and r["legacy_key"] == "trace-001")
        self.assertEqual(record["detail"], "status distilled -> complete")
        self.assertEqual(self.report["policies"]["trace_status_mapped"], 2)

    # -- the TS kernel reads it back ----------------------------------------

    def test_ts_kernel_reads_every_migrated_node_back(self):
        readback = self.report["readback"]
        self.assertEqual(readback["listed_nodes"], {LAB: 6, SIDE: 1})
        self.assertEqual(readback["heads_ok"], 7)
        self.assertEqual(readback["codec_failures"], {})
        self.assertTrue(readback["target_dataset_ok"])
        self.assertEqual(readback["projection_failures"], [])
        self.assertEqual(readback["codec_rows"]["node_revision_terms"], 13)
        self.assertEqual(readback["codec_rows"]["search_chunks_v1"], 7, "pending chunks: vectors rebuilt, never reused")
        self.assertTrue(self.report["verified"])

    # -- the report must never look green on inherited gates ---------------

    def test_report_names_the_release_excluded_gates(self):
        excluded = {e["issue"]: e for e in self.report["release_exclusions"]}
        self.assertEqual(set(excluded), {7, 8, 10})
        self.assertIn("judgment", excluded[7]["gate"])
        self.assertIn("container", excluded[8]["gate"])
        self.assertIn("quality", excluded[10]["gate"])
        self.assertFalse(self.report["release_ready"])

    # -- determinism --------------------------------------------------------

    def test_rerun_into_a_second_empty_candidate_is_identical(self):
        report2, candidate2, _ = _run(self.parent, "second")
        for name in TARGET_TABLE_NAMES:
            with self.subTest(table=name):
                a = sorted(json.dumps(r, default=str, sort_keys=True) for r in _rows(self.candidate, name))
                b = sorted(json.dumps(r, default=str, sort_keys=True) for r in _rows(candidate2, name))
                self.assertEqual(a, b)
        self.assertEqual(report2["tables"], self.report["tables"])

    def _records(self) -> list[dict]:
        return [json.loads(line) for line in (self.work / "records.jsonl").read_text().splitlines()]


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
        before = _tree(candidate)
        with self.assertRaises(CopyMigrationRefused) as ctx:
            run_copy_migration(self.parent / "source", candidate, self.parent / "work", intake_at=INTAKE_AT)
        self.assertEqual(ctx.exception.code, "candidate_not_empty")
        self.assertEqual(_tree(candidate), before)
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

    def test_a_worker_fault_fails_loud_and_leaves_the_source_untouched(self):
        from arra_migrate.copy_migration import CopyMigrationFailed, run_copy_migration

        candidate = self.parent / "candidate"
        candidate.mkdir()
        before = _tree(self.parent / "source")
        # `false` stands in for a Bun worker that dies: exit 1, no lines.
        with self.assertRaises(CopyMigrationFailed):
            run_copy_migration(self.parent / "source", candidate, self.parent / "work",
                               intake_at=INTAKE_AT, bun=shutil.which("false"))
        self.assertEqual(_tree(self.parent / "source"), before)
        self.assertFalse((self.parent / "work" / "report.json").exists(), "no report that could read as success")

    def test_refuses_a_sub_millisecond_intake_time(self):
        from arra_migrate.copy_migration import CopyMigrationRefused, run_copy_migration

        candidate = self.parent / "candidate"
        candidate.mkdir()
        with self.assertRaises(CopyMigrationRefused) as ctx:
            run_copy_migration(self.parent / "source", candidate, self.parent / "work",
                               intake_at="2026-09-26T14:00:00.000123Z")
        self.assertEqual(ctx.exception.code, "invalid_intake_at")


if __name__ == "__main__":
    unittest.main()
