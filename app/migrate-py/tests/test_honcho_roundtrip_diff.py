"""`diff.diff_against_input` and `diff.honcho_to_bundle`. Issue #8, ruling R15.

The predecessor mechanism (`bundle.verify_round_trip`) compared two Honcho
reads of the SAME import and could not, by construction, catch a target that
corrupts data identically on every read (issue #8 repro B: a
`CorruptingHonchoTarget` that drops metadata, drops a message, nulls
`created_at` and reverses order passed it with `ok=True`). These tests exercise
`diff_against_input` -- the comparison against the ORIGINAL v4 bundle -- on
exactly those failure shapes, plus the "unknown column" enforcement issue #8
repro C found missing (target-19's `source_*`/`ingested_at` columns dropped
with `flagged=set()`).
"""

from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from arra_migrate.honcho_roundtrip import names
from arra_migrate.honcho_roundtrip.bundle import export_from_honcho, export_to_honcho
from arra_migrate.honcho_roundtrip.diff import diff_against_input, honcho_to_bundle
from arra_migrate.honcho_roundtrip.dump import (
    WORKSPACE_NAME,
    build_spec_15_5_bank,
    dump_tier1,
)
from arra_migrate.honcho_roundtrip.target import FakeHonchoTarget

SESSION_NAMES = ["session-one", "session-two"]


def _round_trip(bundle):
    target = FakeHonchoTarget()
    export_to_honcho(target, bundle)
    export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
    returned = honcho_to_bundle(export, WORKSPACE_NAME)
    return diff_against_input(bundle, returned)


class SpecBankRoundTripDiffTests(unittest.TestCase):
    """The main claim: SPEC §15.5's own bank survives export -> import ->
    export -> diff with NO unexplained problems."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_the_spec_15_5_bank_round_trips_with_no_problems(self) -> None:
        report = _round_trip(self.bank)
        self.assertEqual(report.problems, [], report.problems)

    def test_peer_configuration_is_not_lossy_when_populated(self) -> None:
        # 2026-09-26 correction: PeerSpec.configuration is a plain
        # dict[str, Any] passthrough with no typed sub-schema -- unlike
        # workspace/session configuration, it must come back byte for byte.
        report = _round_trip(self.bank)
        self.assertNotIn(("peers", "configuration"), report.lossy_fields_confirmed)
        self.assertNotIn(("peers", "configuration"), report.lossy_fields_by_construction)
        self.assertFalse(any("peers" in p and "configuration" in p for p in report.problems))

    def test_a_departed_peer_produces_a_declared_note_not_a_problem(self) -> None:
        report = _round_trip(self.bank)
        self.assertTrue(
            any("neo" in note and "left_at" in note for note in report.declared_notes),
            report.declared_notes,
        )
        self.assertFalse(any("neo" in p for p in report.problems), report.problems)

    def test_workspace_and_session_configuration_are_the_only_by_construction_entries(self) -> None:
        report = _round_trip(self.bank)
        self.assertEqual(
            report.lossy_fields_by_construction,
            {("workspaces", "configuration"), ("sessions", "configuration")},
        )


class DumpedBankChainTests(unittest.TestCase):
    """2026-09-26 fix-round-two finding, analysis-8 tests #10/#11: every
    round-trip test up to this point (including `SpecBankRoundTripDiffTests`
    above) diffs the IN-MEMORY rows `build_spec_15_5_bank` returns, never the
    bank `dump_tier1` reads back off disk -- so a defect in `dump_tier1`
    itself (a wrong column filter, a missed per-session sort, a lost
    timezone) had no test that would ever see it. Chains the whole pipeline
    for real: `build_spec_15_5_bank` (write) -> `dump_tier1` (read back off
    the SAME on-disk dataset) -> `export_to_honcho` -> `diff_against_input`."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-dumped-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        build_spec_15_5_bank(self.root)

    def test_the_dumped_bank_round_trips_with_no_problems(self) -> None:
        dumped = dump_tier1(self.root, WORKSPACE_NAME)
        report = _round_trip(dumped)
        self.assertEqual(report.problems, [], report.problems)


class WorkspaceConfigurationReservedKeyCollisionTests(unittest.TestCase):
    """The narrow case `bundle.LOSSY_FIELDS`' workspaces/sessions.configuration
    reason describes: WorkspaceConfiguration has `extra="allow"`, but a value
    placed under one of its four typed sub-schema names loses any sub-key that
    schema does not itself declare."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-collision-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_a_reserved_key_with_an_unknown_sub_key_loses_that_sub_key(self) -> None:
        bank = build_spec_15_5_bank(self.root)
        bank.workspaces[0]["configuration"] = '{"peer_card": {"max_tokens": 500, "use": true}, "notes": "kept"}'

        report = _round_trip(bank)

        # Not reported as a problem -- it IS declared, in LOSSY_FIELDS.
        self.assertEqual(report.problems, [], report.problems)
        self.assertIn(("workspaces", "configuration"), report.lossy_fields_by_construction)

        target = FakeHonchoTarget()
        export_to_honcho(target, bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        # `max_tokens` is not a field PeerCardConfiguration declares -- gone.
        # `use` is -- survives. `notes` is outside the four reserved names --
        # survives untouched (this IS the "extra=allow" passthrough).
        self.assertEqual(export.workspace["configuration"], {"peer_card": {"use": True}, "notes": "kept"})


class UnknownColumnIsAProblemTests(unittest.TestCase):
    """Issue #8 repro C: a column diff_against_input has never seen declared
    must be reported, not silently dropped."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-unknown-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_an_undeclared_new_message_column_is_reported_as_a_problem(self) -> None:
        bank = copy.deepcopy(self.bank)
        bank.messages[0]["some_future_v4_column"] = "not declared anywhere"

        report = _round_trip(bank)

        self.assertFalse(report.ok)
        self.assertTrue(
            any("some_future_v4_column" in p and "unknown column" in p for p in report.problems),
            report.problems,
        )

    def test_an_undeclared_new_peer_column_is_reported_as_a_problem(self) -> None:
        bank = copy.deepcopy(self.bank)
        bank.peers[0]["some_future_v4_column"] = "not declared anywhere"

        report = _round_trip(bank)

        self.assertFalse(report.ok)
        self.assertTrue(any("some_future_v4_column" in p for p in report.problems), report.problems)

    def test_target19_only_message_columns_are_declared_not_silently_dropped(self) -> None:
        """The exact shape of issue #8 repro C: target-19's
        source_namespace/source_message_id/source_payload_digest/
        source_created_at/ingested_at must be declared lossy, confirmed when
        populated, and never reported as a problem."""

        from datetime import datetime, timezone

        bank = copy.deepcopy(self.bank)
        t0 = datetime(2026, 9, 26, 21, 0, 0, tzinfo=timezone.utc)
        bank.messages[0].update(
            source_namespace="jsonl",
            source_message_id="msg-ext-1",
            source_payload_digest="a" * 64,
            source_created_at=t0,
            ingested_at=t0,
            internal_metadata='{"do_not_forward": true}',
        )

        report = _round_trip(bank)

        self.assertEqual(report.problems, [], report.problems)
        for field in ("source_namespace", "source_message_id", "source_payload_digest", "source_created_at", "ingested_at", "internal_metadata"):
            self.assertIn(("messages", field), report.lossy_fields_confirmed, field)


class CorruptingHonchoTarget(FakeHonchoTarget):
    """A target that corrupts data the SAME way on every read -- issue #8
    repro B, made concrete: `bundle.verify_round_trip` (comparing two reads of
    the same import) cannot see this, because both reads see the same
    corruption. `diff_against_input` (comparing against the ORIGINAL v4
    bundle) must."""

    def create_peer(self, workspace_id: str, peer_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return super().create_peer(workspace_id, peer_id, {}, {})  # metadata dropped

    def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Drop the first message, reverse the rest, null created_at on what's left.
        kept = list(reversed(messages[1:]))
        for m in kept:
            m["created_at"] = None
        return super().create_messages(workspace_id, session_id, kept) if kept else []


class CorruptingTargetIsCaughtTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-corrupt-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_dropped_metadata_is_caught(self) -> None:
        target = CorruptingHonchoTarget()
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)
        self.assertFalse(report.ok)
        self.assertTrue(any("h_metadata" in p for p in report.problems), report.problems)

    def test_a_dropped_and_reversed_message_is_caught(self) -> None:
        target = CorruptingHonchoTarget()
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)
        self.assertFalse(report.ok)
        # Either the count mismatch or the reordered/nulled content is enough
        # to fail -- assert on the general shape, not one specific message.
        self.assertTrue(
            any("dropped" in p or "content" in p or "created_at" in p for p in report.problems),
            report.problems,
        )


class ConfigDroppingHonchoTarget(FakeHonchoTarget):
    """2026-09-26 fix-round finding, probe P4: a target that stores `{}` for
    EVERY workspace/session configuration, no matter what was actually sent.
    Before this fix round, `_diff_workspace`/`_diff_sessions` never compared
    `configuration` at all -- it fell through to `_check_row_columns`, which
    treated the WHOLE column as declared-lossy (`LOSSY_FIELDS_BY_CONSTRUCTION`)
    and only ever recorded it as "confirmed lossy", never checked it against
    anything -- so this wholesale drop passed with `problems=[]`."""

    def create_workspace(self, workspace_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return super().create_workspace(workspace_id, metadata, {})

    def create_session(self, workspace_id: str, session_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return super().create_session(workspace_id, session_id, metadata, {})


class WorkspaceAndSessionConfigurationAreActuallyComparedTests(unittest.TestCase):
    """`diff_against_input` must compare workspace/session `configuration`
    against its expected, schema-normalized value -- not treat the whole
    column as unconditionally lossy just because a RESERVED sub-key can lose a
    sub-field (see `WorkspaceConfigurationReservedKeyCollisionTests` for that
    narrower, legitimate case)."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-wsconfig-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)
        # No RESERVED key here (see CONFIG_RESERVED_FIELDS) -- an ordinary
        # `extra="allow"` top-level key, which must round-trip byte for byte.
        self.bank.workspaces[0]["configuration"] = json.dumps({"notes": "must survive (extra=allow)"})
        for sess in self.bank.sessions:
            sess["configuration"] = json.dumps({"notes": "session extra key"})

    def test_a_real_configuration_round_trips_with_no_problems(self) -> None:
        report = _round_trip(self.bank)
        self.assertEqual(report.problems, [], report.problems)

    def test_wholesale_dropped_workspace_and_session_configuration_is_caught(self) -> None:
        target = ConfigDroppingHonchoTarget()
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)

        self.assertFalse(report.ok)
        self.assertTrue(any(p.startswith("workspaces.configuration") for p in report.problems), report.problems)
        self.assertTrue(any(p.startswith("sessions.configuration") for p in report.problems), report.problems)


class PeerConfigurationDroppingHonchoTarget(FakeHonchoTarget):
    """Mutation M11 (2026-09-26 fix-round finding): drops peer configuration to
    `{}` on every create. `CorruptingHonchoTarget` above never touches peer
    CONFIGURATION (only metadata and messages), so this gap survived
    independently of that class."""

    def create_peer(self, workspace_id: str, peer_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return super().create_peer(workspace_id, peer_id, metadata, {})


class PeerConfigurationCorruptionIsCaughtTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-peerconfig-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_dropped_peer_configuration_is_caught(self) -> None:
        # "nat" carries a real configuration in the SPEC bank (`{"observe_me": true}`).
        target = PeerConfigurationDroppingHonchoTarget()
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)

        self.assertFalse(report.ok)
        self.assertTrue(any(p.startswith("peers.configuration") for p in report.problems), report.problems)


class MetadataDroppingHonchoTarget(FakeHonchoTarget):
    """Mutations M12/M13 (2026-09-26 fix-round finding): drops WORKSPACE and
    SESSION metadata to `{}`. `CorruptingHonchoTarget` above only ever
    corrupts PEER metadata, so removing the workspace/session `h_metadata`
    comparisons in `diff.py` survived independently."""

    def create_workspace(self, workspace_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return super().create_workspace(workspace_id, {}, configuration)

    def create_session(self, workspace_id: str, session_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        return super().create_session(workspace_id, session_id, {}, configuration)


class WorkspaceAndSessionMetadataCorruptionIsCaughtTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-metadata-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_dropped_workspace_and_session_metadata_is_caught(self) -> None:
        target = MetadataDroppingHonchoTarget()
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)

        self.assertFalse(report.ok)
        self.assertTrue(any(p.startswith("workspaces.h_metadata") for p in report.problems), report.problems)
        self.assertTrue(any(p.startswith("sessions.h_metadata") for p in report.problems), report.problems)


class SessionPeerDroppingHonchoTarget(FakeHonchoTarget):
    """Mutation M17 (2026-09-26 fix-round finding): silently drops the LAST
    peer out of every `add_session_peers` call. `CorruptingHonchoTarget` above
    never touches session membership at all, so removing
    `_diff_session_peers`'s comparison survived independently."""

    def add_session_peers(self, workspace_id: str, session_id: str, peers: dict[str, dict[str, Any]]) -> dict[str, Any]:
        trimmed = dict(list(peers.items())[:-1]) if len(peers) > 1 else dict(peers)
        return super().add_session_peers(workspace_id, session_id, trimmed)


class SessionPeerMembershipCorruptionIsCaughtTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-sessionpeers-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_a_silently_dropped_session_member_is_caught(self) -> None:
        target = SessionPeerDroppingHonchoTarget()
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)

        self.assertFalse(report.ok)
        self.assertTrue(
            any("session_peers[" in p and "expected members" in p for p in report.problems),
            report.problems,
        )


class WorkspaceNameCorruptingHonchoTarget(FakeHonchoTarget):
    """2026-09-26 fix-round-two finding: `_diff_workspace`'s `"name"` entry
    (`handled["name"] = (iw["name"], ow["name"], True)`) is a `must_equal`
    comparison the verifier found NO test pins -- flipping that `True` to
    `False` stayed green. Corrupts ONLY the workspace `id` on READ: every
    other row (`peers`, `sessions`, `messages`) gets its `workspace_name`
    from the caller-supplied constant passed to `honcho_to_bundle`, not from
    this value, so this isolates the workspace-name comparison from every
    other check."""

    def get_workspace(self, workspace_id: str) -> dict[str, Any]:
        row = super().get_workspace(workspace_id)
        row["id"] = row["id"] + "-corrupted"
        return row


class WorkspaceNameCorruptionIsCaughtTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-wsname-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_a_renamed_workspace_is_caught(self) -> None:
        target = WorkspaceNameCorruptingHonchoTarget()
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)

        self.assertFalse(report.ok)
        self.assertTrue(any(p.startswith("workspaces.name:") for p in report.problems), report.problems)


class PeerDroppingHonchoTarget(FakeHonchoTarget):
    """2026-09-26 fix-round-two finding: `_diff_peers`' "missing from Honcho"
    check (diff.py) is the only place that catches a peer disappearing
    OUTRIGHT (as opposed to surviving with a corrupted field, which every
    other peer test here already covers) -- the verifier found removing that
    one `if missing:` block stayed green. Silently refuses to store exactly
    one peer, so `list_peers` never returns it."""

    def create_peer(self, workspace_id: str, peer_id: str, metadata: dict[str, Any], configuration: dict[str, Any]) -> dict[str, Any]:
        if peer_id == names.honcho_name("neo"):
            return {"id": peer_id, "workspace_id": workspace_id, "metadata": {}, "configuration": {}, "created_at": None}
        return super().create_peer(workspace_id, peer_id, metadata, configuration)


class PeerMissingFromHonchoIsCaughtTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-peermissing-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_a_peer_silently_dropped_from_honcho_is_reported_missing(self) -> None:
        target = PeerDroppingHonchoTarget()
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)

        self.assertFalse(report.ok)
        self.assertTrue(any(p.startswith("peers: missing from Honcho after import:") for p in report.problems), report.problems)


if __name__ == "__main__":
    unittest.main()
