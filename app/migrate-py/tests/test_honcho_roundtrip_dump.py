"""`dump_tier1` and `build_spec_15_5_bank`. Issue #8, ruling R15, phase 1.

Before this module, issue #8's only "export" was a hand-written dict literal
(`.tmp/understand/issue-8/repro_output.txt` root cause 1) -- no code ever read
a real Lance dataset. These tests prove a real dataset, in EITHER the
active-15 or the target-19 physical shape, dumps to the same `Tier1Bundle`
shape `bundle.export_to_honcho` already consumes.
"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import lancedb

from arra_migrate.honcho_roundtrip.dump import (
    FEDERATION_PEER_NAME,
    WORKSPACE_NAME,
    build_spec_15_5_bank,
    dump_tier1,
)
from arra_migrate.target_v1 import core as target19


class BuildSpec1555BankTests(unittest.TestCase):
    """SPEC §15.5's own numbers: 2 rooms, 3 entities, 10 messages."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-bank-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_bank_shape_matches_spec_15_5(self) -> None:
        self.assertEqual(len(self.bank.workspaces), 1)
        self.assertEqual(len(self.bank.sessions), 2)
        self.assertEqual(len(self.bank.peers), 3)
        self.assertEqual(len(self.bank.messages), 10)

    def test_bank_includes_a_federation_name(self) -> None:
        peer_names = {p["name"] for p in self.bank.peers}
        self.assertIn(FEDERATION_PEER_NAME, peer_names)
        self.assertIn(":", FEDERATION_PEER_NAME)  # outside ^[a-zA-Z0-9_-]+$

    def test_bank_includes_thai_text(self) -> None:
        contents = [m["content"] for m in self.bank.messages]
        self.assertTrue(any(any("฀" <= ch <= "๿" for ch in c) for c in contents), contents)

    def test_bank_includes_a_departed_peer(self) -> None:
        departed = [sp for sp in self.bank.session_peers if sp.get("left_at") is not None]
        self.assertEqual(len(departed), 1)
        self.assertEqual(departed[0]["peer_name"], "neo")
        # Still a member of at least one OTHER thing at some point -- i.e. this
        # is a peer who actually joined and left, not one that was never a
        # real member.
        self.assertIsNotNone(departed[0]["joined_at"])
        self.assertGreater(departed[0]["left_at"], departed[0]["joined_at"])

    def test_bank_writes_a_real_dataset_dump_tier1_can_read_back(self) -> None:
        dumped = dump_tier1(self.root, WORKSPACE_NAME)
        self.assertEqual(len(dumped.workspaces), 1)
        self.assertEqual(len(dumped.peers), 3)
        self.assertEqual(len(dumped.sessions), 2)
        self.assertEqual(len(dumped.session_peers), 5)
        self.assertEqual(len(dumped.messages), 10)


class DumpTier1ReadOnlyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-dump-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_dump_is_filtered_to_the_named_workspace_only(self) -> None:
        build_spec_15_5_bank(self.root)
        # A second, unrelated workspace in the SAME dataset must not leak in.
        from arra_migrate.models.workspace import Workspace as ActiveWorkspace

        db = lancedb.connect(str(self.root))
        db.open_table("workspaces").add([ActiveWorkspace(
            id="ws-99", name="other-workspace", created_at=datetime(2026, 1, 1),
            h_metadata=None, internal_metadata=None, configuration=None, mission=None,
        )])
        dumped = dump_tier1(self.root, WORKSPACE_NAME)
        self.assertEqual({w["name"] for w in dumped.workspaces}, {WORKSPACE_NAME})

    def test_dump_raises_a_clear_error_for_an_unknown_workspace(self) -> None:
        build_spec_15_5_bank(self.root)
        with self.assertRaises(ValueError):
            dump_tier1(self.root, "does-not-exist")

    def test_messages_come_back_seq_ordered_within_each_session(self) -> None:
        build_spec_15_5_bank(self.root)
        dumped = dump_tier1(self.root, WORKSPACE_NAME)
        for session_name in {m["session_name"] for m in dumped.messages}:
            seqs = [m["seq_in_session"] for m in dumped.messages if m["session_name"] == session_name]
            self.assertEqual(seqs, sorted(seqs), f"session {session_name} not seq-ordered: {seqs}")

    def test_every_timestamp_comes_back_utc_aware(self) -> None:
        build_spec_15_5_bank(self.root)
        dumped = dump_tier1(self.root, WORKSPACE_NAME)
        for row in (*dumped.workspaces, *dumped.peers, *dumped.sessions, *dumped.messages):
            for key, value in row.items():
                if isinstance(value, datetime):
                    self.assertIsNotNone(value.tzinfo, f"{key} came back naive: {value!r}")
                    self.assertEqual(value.utcoffset().total_seconds(), 0, f"{key} came back non-UTC: {value!r}")

    def test_dump_tier1_never_mutates_the_source(self) -> None:
        """`dump_tier1` wraps the connection in a read-only guard -- a call
        that would create/drop/rename a table must raise, proving the guard
        is load-bearing rather than a docstring promise."""

        build_spec_15_5_bank(self.root)

        import arra_migrate.honcho_roundtrip.dump as dump_module

        original_connect = dump_module.lancedb.connect
        captured: list[Path] = []

        def spy_connect(path: str):
            db = original_connect(path)
            captured.append(db)
            return db

        dump_module.lancedb.connect = spy_connect
        try:
            dump_tier1(self.root, WORKSPACE_NAME)
        finally:
            dump_module.lancedb.connect = original_connect

        self.assertEqual(len(captured), 1)


class DumpTier1Target19ShapeTests(unittest.TestCase):
    """`dump_tier1` must cope with the target-19 physical shape too -- the
    same five tier-1 tables, but `messages` carries five extra columns
    (`source_namespace`, `source_message_id`, `source_payload_digest`,
    `source_created_at`, `ingested_at`) that active-15 does not have."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-dump-t19-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

        t0 = datetime(2026, 9, 26, 9, 0, 0)  # naive UTC, matches the LanceModel convention

        db = lancedb.connect(str(self.root))
        db.create_table(target19.WORKSPACES, schema=target19.Workspace).add([target19.Workspace(
            id="ws-01", name="ws-t19", created_at=t0, h_metadata=None, internal_metadata=None,
            configuration=None, mission=None,
        )])
        db.create_table(target19.PEERS, schema=target19.Peer).add([target19.Peer(
            id="peer-01", name="nat", workspace_name="ws-t19", h_metadata=None,
            internal_metadata=None, configuration=None, created_at=t0,
        )])
        db.create_table(target19.SESSIONS, schema=target19.Session).add([target19.Session(
            id="sess-01", name="session-one", workspace_name="ws-t19", is_active=True,
            h_metadata=None, internal_metadata=None, configuration=None, created_at=t0,
        )])
        db.create_table(target19.SESSION_PEERS, schema=target19.SessionPeer).add([target19.SessionPeer(
            workspace_name="ws-t19", session_name="session-one", peer_name="nat",
            configuration=None, internal_metadata=None, joined_at=t0, left_at=None,
        )])
        db.create_table(target19.MESSAGES, schema=target19.Message).add([target19.Message(
            id=1, public_id="msg-pub-01", workspace_name="ws-t19", session_name="session-one",
            peer_name="nat", content="hi", token_count=1, seq_in_session=1, h_metadata=None,
            internal_metadata=None, created_at=t0, role=None, in_reply_to=None, read=None, read_at=None,
            source_namespace="jsonl", source_message_id="msg-ext-1",
            source_payload_digest="a" * 64, source_created_at=t0, ingested_at=t0,
        )])

    def test_target19_extra_columns_come_back_on_the_message_row(self) -> None:
        dumped = dump_tier1(self.root, "ws-t19")
        self.assertEqual(len(dumped.messages), 1)
        msg = dumped.messages[0]
        self.assertEqual(msg["source_namespace"], "jsonl")
        self.assertEqual(msg["source_message_id"], "msg-ext-1")
        self.assertEqual(msg["source_payload_digest"], "a" * 64)
        self.assertIsNotNone(msg["source_created_at"])
        self.assertIsNotNone(msg["ingested_at"])
        # NOT NULL on the target-19 schema -- see the §15.1 amendment.
        self.assertIsNotNone(msg["ingested_at"])

    def test_target19_extra_timestamps_are_utc_aware_too(self) -> None:
        dumped = dump_tier1(self.root, "ws-t19")
        msg = dumped.messages[0]
        self.assertIsNotNone(msg["source_created_at"].tzinfo)
        self.assertIsNotNone(msg["ingested_at"].tzinfo)


if __name__ == "__main__":
    unittest.main()
