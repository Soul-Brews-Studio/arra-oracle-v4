"""`diff._diff_messages` / `diff._diff_one_message`, split out of
`test_honcho_roundtrip_diff.py` to stay under this repo's 500-line-per-file
limit. Issue #8, ruling R15, 2026-09-26 fix round.

An independent Opus verifier applied mutations to `diff.py`/`bundle.py` and
the whole suite stayed green -- the only message-corruption test that
existed before this file (`test_honcho_roundtrip_diff.CorruptingTargetIsCaughtTests
.test_a_dropped_and_reversed_message_is_caught`) asserts `any("dropped" in p
or "content" in p or "created_at" in p ...)`, broad enough that a count
mismatch alone satisfies it. So message ORDERING (issue #8 repro D) and each
of `_diff_one_message`'s individual per-field comparisons were never
independently pinned by a test that fails when that specific comparison is
removed. See each class's own docstring for the exact mutation it kills, and
this fix round's structured result for the scratch-copy proof (each mutation
applied on its own, the specific test recorded as going red)."""

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


class MessageOrderingTests(unittest.TestCase):
    """Issue #8 repro D / analysis-8 test #4, 2026-09-26 fix-round finding:
    NOTHING pinned message ORDERING with a test that fails when the ordering
    fix is removed. Two independent mutations survived the whole suite at 68
    OK each, because they attack two different places that both have to be
    right for ordering to actually be checked:

      (a) `_diff_messages` sorting BOTH `ins` and `outs` by `content` before
          pairing them up, instead of comparing `outs` in Honcho's own
          returned order against `ins` sorted by `seq_in_session` -- this
          defeats a target-side reorder, because every message still finds
          its own twin by content regardless of where it landed.
      (b) `export_to_honcho` sending `list(bundle.messages)` unmutated
          instead of `sorted(..., key=... seq_in_session)` -- this survived
          specifically because `dump.build_spec_15_5_bank`'s own `messages`
          list HAPPENS to already be in seq order, so removing the sort was
          a no-op against every existing fixture.

    The two tests below are built to fail under (a) and (b) respectively,
    not just to re-confirm ordering is checked at all under the bank's own
    already-sorted list."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-order-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def test_messages_sent_and_compared_in_seq_in_session_order(self) -> None:
        """Kills mutation (b). The input `messages` list is deliberately NOT
        in `seq_in_session` order -- if `export_to_honcho` ever stops
        sorting before it sends, `FakeHonchoTarget` (which appends messages
        in exactly the order it receives them, see its own docstring) would
        return them in this same scrambled order, and the diff -- which
        always sorts the INPUT side by `seq_in_session` -- would report
        positional mismatches. Only a real pre-send sort makes this pass."""

        scrambled = copy.deepcopy(self.bank)
        scrambled.messages = list(reversed(scrambled.messages))
        session_one_seqs = [m["seq_in_session"] for m in scrambled.messages if m["session_name"] == "session-one"]
        self.assertNotEqual(session_one_seqs, sorted(session_one_seqs), "fixture is not actually scrambled")

        report = _round_trip(scrambled)

        self.assertEqual(report.problems, [], report.problems)

    def test_a_target_that_returns_messages_out_of_order_is_caught(self) -> None:
        """Kills mutation (a). The bank's OWN messages list is already in
        seq order (see the class docstring) and `export_to_honcho` sends
        them correctly -- the fault is entirely on Honcho's side, in
        `list_messages` returning a different order than it received. Only a
        diff that compares actual returned order (not sorted-by-content
        order) against the seq-ordered input catches this."""

        class MessageReorderingHonchoTarget(FakeHonchoTarget):
            def list_messages(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
                return list(reversed(super().list_messages(workspace_id, session_id)))

        target = MessageReorderingHonchoTarget()
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)

        self.assertFalse(report.ok)
        # session-one has 6 messages, all distinct content -- reversing
        # Honcho's return order pairs position 0 (the message v4 sent
        # FIRST) against the message Honcho created LAST, so this is a
        # content/peer_name mismatch at a specific position, not merely a
        # count mismatch (both sides still report 6 messages).
        self.assertTrue(
            any(p.startswith("messages[session-one][0].") for p in report.problems),
            report.problems,
        )


class PerFieldMessageCorruptionTests(unittest.TestCase):
    """Issue #8, 2026-09-26 fix-round finding: the only message-corruption
    test before this (`test_honcho_roundtrip_diff.CorruptingTargetIsCaughtTests
    .test_a_dropped_and_reversed_message_is_caught`) asserts `any("dropped"
    in p or "content" in p or "created_at" in p ...)` -- broad enough that
    the count mismatch ALONE satisfies it, so none of `_diff_one_message`'s
    individual per-field comparisons (created_at, content, peer_name,
    h_metadata, each folded v4 field) or `_diff_messages`'s own
    count-mismatch problem string were ever independently pinned. Each test
    below corrupts exactly ONE field on exactly ONE message, leaving the
    rest of the bank (and that message's other fields) untouched, and
    asserts the SPECIFIC problem string `_diff_one_message`/`_diff_messages`
    emits for that field -- verified (2026-09-26) to go red when that
    field's own comparison is deleted from `diff.py`, in a scratch copy,
    independently of every other check."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-diff-perfield-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)

    def _run(self, target: FakeHonchoTarget):
        export_to_honcho(target, self.bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        return diff_against_input(self.bank, returned)

    def test_created_at_corruption_is_caught(self) -> None:
        class CreatedAtNullingHonchoTarget(FakeHonchoTarget):
            def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
                messages = [dict(m) for m in messages]
                for m in messages:
                    if m["content"] == "let's start the round trip":  # session-one, position 0
                        m["created_at"] = None  # Honcho stamps its own -- see _now()
                return super().create_messages(workspace_id, session_id, messages)

        report = self._run(CreatedAtNullingHonchoTarget())

        self.assertFalse(report.ok)
        self.assertTrue(
            any(p.startswith("messages[session-one][0].created_at:") for p in report.problems),
            report.problems,
        )

    def test_content_corruption_is_caught(self) -> None:
        class ContentMutatingHonchoTarget(FakeHonchoTarget):
            def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
                messages = [dict(m) for m in messages]
                for m in messages:
                    if m["content"] == "second session starts":  # session-two, position 0
                        m["content"] = "second session starts -- corrupted in transit"
                return super().create_messages(workspace_id, session_id, messages)

        report = self._run(ContentMutatingHonchoTarget())

        self.assertFalse(report.ok)
        self.assertTrue(
            any(p.startswith("messages[session-two][0].content:") for p in report.problems),
            report.problems,
        )

    def test_peer_name_corruption_is_caught(self) -> None:
        class PeerSwappingHonchoTarget(FakeHonchoTarget):
            def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
                messages = [dict(m) for m in messages]
                for m in messages:
                    if m["content"] == "observing from m5":  # session-one position 2, sent by the federation peer
                        m["peer_id"] = "nat"
                return super().create_messages(workspace_id, session_id, messages)

        report = self._run(PeerSwappingHonchoTarget())

        self.assertFalse(report.ok)
        self.assertTrue(
            any(p.startswith("messages[session-one][2].peer_name:") for p in report.problems),
            report.problems,
        )

    def test_h_metadata_corruption_is_caught(self) -> None:
        class MessageMetadataMutatingHonchoTarget(FakeHonchoTarget):
            def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
                messages = [dict(m) for m in messages]
                for m in messages:
                    if m["content"] == "ภาษาไทย 🌱 ทดสอบการ round trip":  # session-one position 1, h_metadata={"note": "kept"}
                        metadata = dict(m.get("metadata") or {})
                        metadata["note"] = "corrupted"  # folded `_v4` sub-dict left untouched
                        m["metadata"] = metadata
                return super().create_messages(workspace_id, session_id, messages)

        report = self._run(MessageMetadataMutatingHonchoTarget())

        self.assertFalse(report.ok)
        self.assertTrue(
            any(p.startswith("messages[session-one][1].h_metadata:") for p in report.problems),
            report.problems,
        )

    def test_a_folded_v4_field_corruption_is_caught(self) -> None:
        class FoldedReadFlagMutatingHonchoTarget(FakeHonchoTarget):
            def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
                messages = [dict(m) for m in messages]
                for m in messages:
                    if m["content"] == "ภาษาไทย 🌱 ทดสอบการ round trip":  # session-one position 1, read=True in the bank
                        metadata = dict(m.get("metadata") or {})
                        folded = dict(metadata.get("_v4") or {})
                        folded["read"] = False
                        metadata["_v4"] = folded
                        m["metadata"] = metadata
                return super().create_messages(workspace_id, session_id, messages)

        report = self._run(FoldedReadFlagMutatingHonchoTarget())

        self.assertFalse(report.ok)
        self.assertIn("messages[session-one][1].read (folded): sent True, got back False", report.problems)

    def test_message_count_mismatch_is_reported_with_the_specific_string(self) -> None:
        class MessageDroppingHonchoTarget(FakeHonchoTarget):
            def create_messages(self, workspace_id: str, session_id: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
                messages = [m for m in messages if m["content"] != "closing thought"]  # session-two, 4 -> 3
                if not messages:
                    return []
                return super().create_messages(workspace_id, session_id, messages)

        report = self._run(MessageDroppingHonchoTarget())

        self.assertFalse(report.ok)
        self.assertIn(
            "messages[session-two]: 4 sent vs 3 returned -- a message was dropped, duplicated, or landed in the wrong session",
            report.problems,
        )


if __name__ == "__main__":
    unittest.main()
