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
    legacy types follow R11 (a type too long to be a term name still migrates
    as ``note``; only its tag is a record), memory_terms became
    node_revision_terms, supersede rows
    follow R17 (a missing log row is synthesized), distilled_at lands in
    internal metadata, not captured_at, raw traces are open, and messages carry
    the frozen intake time;
  - R17 flat vocabularies hold NO parent (the kernel reads one as corruption):
    a legacy parent is dropped and recorded, and a cross-row check catches one;
    vocabulary and term names over the kernel's 256-BYTE bound are rejected;
  - the TS kernel reads every migrated node back and every stored row passes
    the TS stored-row codecs;
  - the inherited release gates #7/#8/#10 are named as EXCLUDED, never green.

What it does not prove: production cutover, R2, or recall quality.
"""

from __future__ import annotations

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
from copy_migration_support import legacy_node_id, records, rows as _rows, run as _run, tree as _tree
from export_legacy_fixture import (
    LAB,
    LONG_TYPE,
    MS0,
    SIDE,
    build_legacy_fixture,
    legacy_rows,
)

#: Rejected before planning: a sub-ms created_at.
REJECTED_MEMORIES = ("m_muigr3dd_subms",)


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
        self.assertEqual(len(migrated), 10)
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

    def test_messages_are_stamped_with_the_frozen_intake_time_never_created_at(self):
        """source-ingestion-v1 amendment: ingested_at is --intake-at, for every row."""

        messages = _rows(self.candidate, "messages")
        self.assertEqual(len(messages), 4)
        for row in messages:
            with self.subTest(message=row["content"]):
                ingested = row["ingested_at"].replace(tzinfo=None)
                self.assertEqual(ingested.isoformat(timespec="milliseconds"), "2026-09-26T14:00:00.000")
                self.assertNotEqual(ingested, row["created_at"].replace(tzinfo=None))
        self.assertEqual(self.report["intake_at"], "2026-09-26T14:00:00.000Z")

    def test_trace_hit_kind_outside_target_kinds_is_rejected_with_a_record(self):
        record = next(r for r in self._records() if r["table"] == "trace_hits" and r["legacy_key"] == "trace-001|0")
        self.assertEqual((record["outcome"], record["code"]), ("rejected", "kind_outside_target_kinds"))
        self.assertEqual(_rows(self.candidate, "trace_hits"), [])

    def test_trace_hit_kind_inside_target_kinds_is_unresolved_not_invented(self):
        record = next(r for r in self._records() if r["table"] == "trace_hits" and r["legacy_key"] == "trace-003|0")
        self.assertEqual((record["outcome"], record["code"]), ("unresolved", "locator_unmappable"))
        self.assertIn("https://example.com/keys", record["detail"])

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

        revisions = {r["node_id"]: r for r in _rows(self.candidate, "node_revisions")}
        for row in legacy_rows()["memories"]:
            if row["id"] in REJECTED_MEMORIES:
                continue
            with self.subTest(memory=row["id"]):
                node_id = legacy_node_id(row["workspace_name"], row["id"])
                self.assertIn(node_id, revisions)
                self.assertEqual(json.loads(revisions[node_id]["internal_metadata"])["legacy_id"], row["id"])

    def test_vector_disposition_never_reuses_a_legacy_vector_across_every_migrated_node(self):
        """#34 TODO 3 (docs/overnight/AC-MATRIX.md slice 7): a DEDICATED,
        whole-fixture check, not folded into the general smoke test above.

        Exactly one legacy memory (``m_muigqmxf_qchtyc``, "forgot-keys") carries
        a legacy ``embedding``; the other nine do not
        (``export_legacy_fixture.py``'s ``_memory`` defaults `embedding=None`).
        `plan.py:98` records ``vector_disposition`` per node from exactly that
        fact: "rebuild_unknown_profile" when a legacy vector existed (it is
        real, but from an unknown/unpinned profile, so it is discarded, never
        reused) and "none" when there was nothing to discard. Both are
        "never reused" -- this test pins the count of each, so a future change
        that silently started COPYING the one real legacy vector into
        `search_chunks_v1.embedding` cannot pass unnoticed by continuing to say
        "rebuild_unknown_profile" while actually reusing it.

        The second half is the actual physical guarantee, independent of the
        label: EVERY migrated node's derived `search_chunks_v1` row is staged
        `pending` with a NULL vector, whether or not its legacy memory had an
        embedding.
        """
        revisions = _rows(self.candidate, "node_revisions")
        heads = [r for r in revisions if r["revision_no"] == 1]
        self.assertEqual(len(heads), 10, "every migrated node's first revision")
        dispositions = [json.loads(h["internal_metadata"])["vector_disposition"] for h in heads]
        self.assertEqual(
            sorted(dispositions),
            sorted(["rebuild_unknown_profile"] + ["none"] * 9),
            "exactly the one legacy memory with a real (discarded) vector is rebuild_unknown_profile",
        )

        chunks = _rows(self.candidate, "search_chunks_v1")
        migrated_node_ids = {h["node_id"] for h in heads}
        migrated_chunks = [c for c in chunks if c["node_id"] in migrated_node_ids]
        self.assertEqual(len(migrated_chunks), 10, "one pending chunk per migrated node, none pre-embedded")
        for chunk in migrated_chunks:
            with self.subTest(chunk_id=chunk["id"]):
                self.assertEqual(chunk["status"], "pending", "never arrives ready: no vector was carried over")
                self.assertIsNone(chunk["embedding"], "a null vector, never a copied or invented one -- true even for the one node whose LEGACY row had a real vector")
                self.assertEqual(chunk["attempts"], 0)
                self.assertIsNone(chunk["embedded_at"])

    def test_memories_become_nodes_with_an_accepted_first_revision(self):
        nodes = _rows(self.candidate, "nodes")
        revisions = {r["id"]: r for r in _rows(self.candidate, "node_revisions")}
        self.assertEqual(len(nodes), 10)
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

    def test_r11_type_too_long_for_a_term_name_still_becomes_note(self):
        """R11: anything not reserved becomes `note`, so nothing is lost.

        A type over the 256-byte term-name bound cannot ALSO be a tag term. The
        memory still migrates as `note` with the full string in
        internal_metadata.legacy_type; only the missing tag is a record.
        """

        by_key = {r["legacy_key"]: r for r in self._records() if r["table"] == "memories"}
        self.assertEqual(by_key["m_muigr6gg_longtype"]["outcome"], "migrated")
        tag = next(r for r in self._records()
                   if r["table"] == "memories.type" and r["legacy_key"] == "m_muigr6gg_longtype")
        self.assertEqual((tag["outcome"], tag["code"]), ("unresolved", "legacy_type_tag_unrepresentable"))
        self.assertIn(str(len(LONG_TYPE.encode())), tag["detail"])
        self.assertIn("256", tag["detail"])
        self.assertEqual(self.report["policies"]["r11_type_tag_unrepresentable"], 1)
        head = next(r for r in _rows(self.candidate, "node_revisions") if r["title"] == "stuffed-type")
        self.assertEqual({(t["vocabulary_name_snapshot"], t["term_name_snapshot"])
                          for t in json.loads(head["term_snapshot_json"])}, {("type", "note")})
        meta = json.loads(head["internal_metadata"])
        self.assertEqual(meta["legacy_type"], LONG_TYPE, "the original string is kept whole")
        self.assertIn("type", meta["unresolved_references"])
        lab = {k for k, r in by_key.items() if r["workspace"] == LAB and r["outcome"] == "migrated"}
        self.assertEqual(len(lab), 7, "every oracle-lab memory with a millisecond clock migrated")
        self.assertEqual([t for t in self.report["readback"]["taxonomy"] if t["outcome"] == "error"], [])
        tags = {t["name"] for t in _rows(self.candidate, "terms") if t["workspace_name"] == LAB}
        self.assertTrue({"retro", "Decision Log"} <= tags)
        self.assertTrue(all(len(name.encode()) <= 256 for name in tags))

    def test_memory_terms_become_node_revision_terms(self):
        revisions = {r["id"]: r["title"] for r in _rows(self.candidate, "node_revisions")}
        projected = {(revisions[r["revision_id"]], r["term_name_snapshot"])
                     for r in _rows(self.candidate, "node_revision_terms")}
        self.assertIn(("forgot-keys", "oracle"), projected)
        self.assertIn(("forgot-keys", "ภาษาไทย"), projected)
        self.assertIn(("keys-by-the-door", "oracle"), projected)
        self.assertIn(("side-correction", "v4"), projected)
        self.assertIn(("keys-by-the-door", "keys"), projected, "a term whose legacy parent was dropped still tags")

    def test_r17_legacy_vocabularies_are_many_optional_flat(self):
        topic = next(v for v in _rows(self.candidate, "vocabularies") if v["name"] == "topic")
        self.assertEqual((topic["cardinality"], topic["required"], topic["hierarchy"]), ("many", False, "flat"))
        clash = next(r for r in self._records() if r["table"] == "vocabularies" and r["legacy_key"] == "vocab-legacy-type")
        self.assertEqual((clash["outcome"], clash["code"]), ("rejected", "reserved_vocabulary_name"))

    def test_r17_flat_vocabulary_drops_a_legacy_parent_and_reports_it(self):
        """The kernel reads a stored parent in a flat vocabulary as corruption
        (service.reparentTerm.ts, taxonomy-write-v1 reparentTerm), so the flat
        policy cannot keep one: parent_id is NULL and the legacy value is a record."""

        terms = {t["name"]: t for t in _rows(self.candidate, "terms")}
        vocabularies = {v["id"]: v for v in _rows(self.candidate, "vocabularies")}
        for term in terms.values():
            with self.subTest(term=term["name"]):
                if vocabularies[term["vocabulary_id"]]["hierarchy"] != "tree":
                    self.assertIsNone(term["parent_id"])
        pointer = next(r for r in self._records() if r["table"] == "terms.parent_id" and r["legacy_key"] == "term-keys")
        self.assertEqual((pointer["outcome"], pointer["code"]), ("unresolved", "parent_dropped_flat_hierarchy"))
        self.assertIn("term-oracle", pointer["detail"])
        self.assertIn(terms["oracle"]["id"], pointer["detail"])
        self.assertEqual(self.report["policies"]["term_parent_dropped"], 1)
        self.assertEqual(self.report["candidate"]["taxonomy_problems"], [])

    def test_the_taxonomy_check_catches_a_parent_planted_in_a_flat_vocabulary(self):
        """The per-row codecs cannot see this cross-row invariant; verify.py must."""

        from arra_migrate.copy_migration.verify import taxonomy_problems

        planted = Path(tempfile.mkdtemp(prefix="arra-copy-planted-"))
        self.addCleanup(shutil.rmtree, planted, ignore_errors=True)
        copy = planted / "candidate"
        shutil.copytree(self.candidate, copy)
        self.assertEqual(taxonomy_problems(copy), [])
        terms = {t["name"]: t for t in _rows(copy, "terms")}
        lancedb.connect(str(copy)).open_table("terms").update(
            where=f"id = '{terms['keys']['id']}'", values={"parent_id": terms["oracle"]["id"]})
        problems = taxonomy_problems(copy)
        self.assertEqual(len(problems), 1)
        self.assertIn("flat", problems[0])

    def test_a_vocabulary_name_over_the_kernel_limit_is_rejected_not_written(self):
        """BYTES, not characters: 90 Thai characters are 270 UTF-8 bytes."""

        record = next(r for r in self._records()
                      if r["table"] == "vocabularies" and r["legacy_key"] == "vocab-toolong")
        self.assertEqual((record["outcome"], record["code"], record["pointer"]), ("rejected", "limit_exceeded", "/name"))
        self.assertIn("270", record["detail"])
        self.assertNotIn("ข" * 90, {v["name"] for v in _rows(self.candidate, "vocabularies")})
        self.assertEqual(self.report["candidate"]["taxonomy_problems"], [])

    def test_a_term_name_over_the_kernel_limit_is_rejected_not_written(self):
        record = next(r for r in self._records() if r["table"] == "terms" and r["legacy_key"] == "term-toolong")
        self.assertEqual((record["outcome"], record["code"], record["pointer"]), ("rejected", "limit_exceeded", "/name"))
        self.assertNotIn("ก" * 90, {t["name"] for t in _rows(self.candidate, "terms")})

    def test_r18_d2_adapter_vocabulary_with_a_different_policy_is_flagged(self):
        record = next(r for r in self._records() if r["table"] == "vocabularies" and r["legacy_key"] == "vocab-project")
        self.assertEqual(record["outcome"], "migrated")
        self.assertIn("R18 D2", record["detail"])
        self.assertEqual(self.report["policies"]["adapter_vocabulary_policy_mismatch"], 1)

    def test_r17_null_supersede_reason_is_backfilled_and_counted(self):
        log = _rows(self.candidate, "supersede_log")
        reasons = sorted(r["reason"] for r in log)
        self.assertEqual(reasons, sorted(["moved the keys", "legacy: reason not recorded",
                                          "superseded by the ngram ruling", "legacy: reason not recorded"]))
        self.assertEqual(self.report["policies"]["null_reason_backfilled"], 1)
        missing = next(r for r in self._records() if r["table"] == "supersede_log" and r["legacy_key"] == "4")
        self.assertEqual(missing["outcome"], "unresolved")
        retire = next(r for r in log if r["reason"] == "superseded by the ngram ruling")
        self.assertIsNone(retire["new_id"])

    def test_superseded_by_without_a_log_row_synthesizes_one_counted_event(self):
        old, new = legacy_node_id(SIDE, "m_side001_old"), legacy_node_id(SIDE, "m_side002_new")
        events = [r for r in _rows(self.candidate, "supersede_log") if r["old_id"] == old]
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]["new_id"], events[0]["reason"], events[0]["workspace_name"]),
                         (new, "legacy: reason not recorded", SIDE))
        self.assertEqual(events[0]["superseded_at"].isoformat(timespec="milliseconds"), "2026-09-20T09:30:00.123")
        self.assertEqual(self.report["policies"]["missing_log_row_backfilled"], 1)
        pointer = next(r for r in self._records()
                       if r["table"] == "memories.superseded_by" and r["legacy_key"] == "m_side001_old")
        self.assertEqual(pointer["outcome"], "resolved")

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
        self.assertEqual(statuses, {"0900_keys-hunt": "complete", "0910_keys-followup": "complete",
                                    "0920_raw-open": "open"})
        record = next(r for r in self._records() if r["table"] == "traces" and r["legacy_key"] == "trace-001")
        self.assertEqual(record["detail"], "status distilled -> complete")
        self.assertEqual(self.report["policies"]["trace_status_mapped"], 3)

    def test_ruled_raw_trace_status_maps_to_open(self):
        """R17 (corrected 22:00): the RULED leg of the status map, not the extension."""

        raw = next(r for r in _rows(self.candidate, "traces") if r["name"] == "0920_raw-open")
        self.assertEqual(raw["status"], "open")
        record = next(r for r in self._records() if r["table"] == "traces" and r["legacy_key"] == "trace-003")
        self.assertEqual((record["outcome"], record["detail"]), ("migrated", "status raw -> open"))

    # -- the TS kernel reads it back ----------------------------------------

    def test_ts_kernel_reads_every_migrated_node_back(self):
        readback = self.report["readback"]
        # listNodes' DEFAULT may exclude superseded/retired nodes once #29 lands
        # (R18 D3), so the listing is bounded, not pinned: every live node at
        # least, every migrated node at most. getAcceptedHead is the exact check.
        live, migrated = {LAB: 4, SIDE: 2}, {LAB: 7, SIDE: 3}
        self.assertEqual(set(readback["listed_nodes"]), {LAB, SIDE})
        for ws, listed in readback["listed_nodes"].items():
            self.assertTrue(live[ws] <= listed <= migrated[ws], (ws, listed))
        self.assertEqual(readback["heads_ok"], 10)
        self.assertEqual(readback["heads_failed"], [])
        self.assertEqual(readback["codec_failures"], {})
        self.assertTrue(readback["target_dataset_ok"])
        self.assertEqual(readback["projection_failures"], [])
        self.assertEqual(readback["codec_rows"]["node_revision_terms"], 17)
        self.assertEqual(readback["codec_rows"]["search_chunks_v1"], 10, "pending chunks: vectors rebuilt, never reused")
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
        return records(self.work)


if __name__ == "__main__":
    unittest.main()
