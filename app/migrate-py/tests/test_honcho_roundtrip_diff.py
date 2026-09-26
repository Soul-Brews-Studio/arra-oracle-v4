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
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from arra_migrate.honcho_roundtrip.bundle import export_from_honcho, export_to_honcho
from arra_migrate.honcho_roundtrip.diff import diff_against_input, honcho_to_bundle
from arra_migrate.honcho_roundtrip.dump import build_spec_15_5_bank, WORKSPACE_NAME
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


if __name__ == "__main__":
    unittest.main()
