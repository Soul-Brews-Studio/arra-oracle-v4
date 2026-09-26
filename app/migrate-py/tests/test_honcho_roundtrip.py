"""§15.5 round-trip test tier -- issue #8, ruling R15 (overnight phase 1).

Two legs, reported honestly as two different things:

  * The FakeHonchoTarget legs -- ACTUALLY RUN, against `FakeHonchoTarget`,
    which encodes the verified v3.2.0 schema constraints (see `target.py`'s
    module docstring for the citations, all re-checked 2026-09-26 against the
    pinned commit). These prove the export/import/export/diff LOGIC in
    `bundle.py` and `diff.py` is correct given that documented behaviour, for
    the real SPEC §15.5 bank (`dump.build_spec_15_5_bank`), not a hand-picked
    dict.
  * `TestLiveRoundTrip` -- would run the SAME bank against a real, pinned
    Honcho process (`pin.HONCHO_V3_2_0`) if `HONCHO_ROUNDTRIP_LIVE_BASE_URL`
    is set. In this session it is UNEXECUTED: no container runtime is
    available (`docker ps` fails -- colima is not running) and the shared
    white.local instance is explicitly ruled out as a target by issue #8's
    2026-09-20 scope correction. The test SKIPS with that reason printed, it
    does not silently pass and it does not fall back to a live target that
    was never authorized.

See `test_honcho_roundtrip_names.py` (name encoding), `test_honcho_roundtrip_dump.py`
(`dump_tier1` / `build_spec_15_5_bank`) and `test_honcho_roundtrip_diff.py`
(`diff_against_input`, `honcho_to_bundle`) for the rest of phase 1's coverage.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from arra_migrate.honcho_roundtrip.bundle import (
    LOSSY_FIELDS,
    LOSSY_FIELDS_BY_CONSTRUCTION,
    Tier1Bundle,
    confirm_fields_absent_from_export,
    export_from_honcho,
    export_to_honcho,
    verify_round_trip,
)
from arra_migrate.honcho_roundtrip.diff import diff_against_input, honcho_to_bundle
from arra_migrate.honcho_roundtrip.dump import WORKSPACE_NAME, build_spec_15_5_bank
from arra_migrate.honcho_roundtrip.limits import MESSAGE_BATCH_MAX, TierOneLimitError
from arra_migrate.honcho_roundtrip.target import FakeHonchoTarget, HttpHonchoTarget

T0 = datetime(2026, 9, 21, 9, 0, 0, tzinfo=timezone.utc)
SESSION_NAMES = ["session-one", "session-two"]


def _fixture_bundle() -> Tier1Bundle:
    """A small, hand-built bundle for the narrower `verify_round_trip`
    ("stable across two reads of the same import") checks below -- the real
    against-input claim is tested against the actual SPEC §15.5 bank in
    `SpecBankFakeRoundTripTests` and `test_honcho_roundtrip_diff.py`."""

    return Tier1Bundle(
        workspaces=[
            {"id": "ws-01", "name": "ws-roundtrip", "created_at": T0,
             "h_metadata": '{"kind": "test"}', "internal_metadata": '{"secret": "not-for-honcho"}',
             "configuration": None, "mission": "round-trip fixture"},
        ],
        peers=[
            {"id": "peer-01", "name": "nat", "workspace_name": "ws-roundtrip",
             "h_metadata": '{"display_name": "Nat"}', "internal_metadata": '{"internal": true}',
             "configuration": None, "created_at": T0},
            {"id": "peer-02", "name": "neo", "workspace_name": "ws-roundtrip",
             "h_metadata": None, "internal_metadata": None, "configuration": None, "created_at": T0},
        ],
        sessions=[
            {"id": "sess-01", "name": "session-one", "workspace_name": "ws-roundtrip",
             "is_active": True, "h_metadata": '{"room": "test"}', "internal_metadata": '{"do_not_forward": true}',
             "configuration": None, "created_at": T0},
        ],
        session_peers=[
            {"workspace_name": "ws-roundtrip", "session_name": "session-one", "peer_name": "nat",
             "configuration": '{"pinned": true}', "internal_metadata": '{"joined_via": "test"}',
             "joined_at": T0, "left_at": None},
            {"workspace_name": "ws-roundtrip", "session_name": "session-one", "peer_name": "neo",
             "configuration": None, "internal_metadata": None, "joined_at": T0, "left_at": T0},
        ],
        messages=[
            {"id": 1, "public_id": "msg-pub-01", "workspace_name": "ws-roundtrip",
             "session_name": "session-one", "peer_name": "nat", "content": "ภาษาไทย 🌱 ทดสอบ round trip",
             "token_count": 3, "seq_in_session": 1, "h_metadata": None, "internal_metadata": None,
             "created_at": T0, "role": "note", "in_reply_to": None, "read": None, "read_at": None},
            {"id": 2, "public_id": "msg-pub-02", "workspace_name": "ws-roundtrip",
             "session_name": "session-one", "peer_name": "neo", "content": "reply",
             "token_count": 1, "seq_in_session": 2, "h_metadata": '{"note": "kept"}', "internal_metadata": None,
             "created_at": T0, "role": "answer", "in_reply_to": "msg-pub-01", "read": True, "read_at": T0},
        ],
    )


class TestExecutedFixtureRoundTrip(unittest.TestCase):
    """Runs for real, against FakeHonchoTarget -- the narrower "stable across
    two reads" claim (`verify_round_trip`), not the against-input diff."""

    def setUp(self) -> None:
        self.bundle = _fixture_bundle()
        self.target = FakeHonchoTarget()
        self.workspace_id = "ws-roundtrip"
        self.session_ids = ["session-one"]

    def test_round_trip_is_equivalent_under_the_stated_exclusions(self) -> None:
        export_to_honcho(self.target, self.bundle)
        first = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        second = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        report = verify_round_trip(self.bundle, first, second)
        self.assertEqual(report.problems, [], report.problems)

    def test_folded_v4_message_fields_survive_inside_metadata(self) -> None:
        export_to_honcho(self.target, self.bundle)
        export = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        by_content = {m["content"]: m for m in export.messages}
        reply = by_content["reply"]
        self.assertEqual(reply["metadata"]["_v4"]["role"], "answer")
        self.assertEqual(reply["metadata"]["_v4"]["in_reply_to"], "msg-pub-01")
        self.assertEqual(reply["metadata"]["_v4"]["read"], True)
        self.assertIn("read_at", reply["metadata"]["_v4"])  # wire-encoded string, not a bare datetime
        self.assertIsInstance(reply["metadata"]["_v4"]["read_at"], str)
        self.assertEqual(reply["metadata"].get("note"), "kept")  # coexists with the fold

    def test_v4_internal_ids_and_internal_metadata_never_reach_the_target(self) -> None:
        export_to_honcho(self.target, self.bundle)  # must not raise
        export = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        for peer in export.peers:
            self.assertNotIn("internal_metadata", peer)
        for msg in export.messages:
            self.assertNotIn("internal_metadata", msg)

    def test_names_outside_the_resource_pattern_are_encoded_on_the_wire(self) -> None:
        bundle = _fixture_bundle()
        bundle.peers.append({
            "id": "peer-03", "name": "m5:arra-oracle-v3", "workspace_name": "ws-roundtrip",
            "h_metadata": None, "internal_metadata": None, "configuration": None, "created_at": T0,
        })
        export_to_honcho(self.target, bundle)  # must not raise on the colon
        export = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        ids = {p["id"] for p in export.peers}
        self.assertNotIn("m5:arra-oracle-v3", ids)  # never sent raw
        self.assertTrue(any(pid.startswith("hnb64-") for pid in ids), ids)


class SpecBankFakeRoundTripTests(unittest.TestCase):
    """The real claim: the SPEC §15.5 bank, export -> import -> export ->
    diff against the ORIGINAL input, with no container."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-rt-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.bank = build_spec_15_5_bank(self.root)
        self.target = FakeHonchoTarget()

    def test_full_round_trip_against_the_spec_15_5_bank(self) -> None:
        export_to_honcho(self.target, self.bank)
        export = export_from_honcho(self.target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)
        self.assertEqual(report.problems, [], report.problems)

    def test_every_declared_lossy_field_is_accounted_for_or_explained(self) -> None:
        """Every `LOSSY_FIELDS` entry is either measured against the bank
        (confirmed) or declared unmeasurable-by-construction -- except the
        five target-19-only message columns, which THIS bank (active-15
        shape) has no columns to populate; `test_honcho_roundtrip_diff.py`
        exercises those against a target-19-shaped bundle instead."""

        export_to_honcho(self.target, self.bank)
        export = export_from_honcho(self.target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(self.bank, returned)

        declared = {(f.table, f.field) for f in LOSSY_FIELDS}
        covered = report.lossy_fields_confirmed | report.lossy_fields_by_construction
        target19_only = {
            ("messages", "source_namespace"), ("messages", "source_message_id"),
            ("messages", "source_payload_digest"), ("messages", "source_created_at"),
            ("messages", "ingested_at"),
            # Not populated anywhere in this bank -- see confirm criteria.
            ("messages", "internal_metadata"),
        }
        missing = declared - covered - target19_only
        self.assertEqual(missing, set(), f"declared lossy but never exercised: {missing}")


class ConfirmFieldsAbsentFromExportTests(unittest.TestCase):
    """`confirm_fields_absent_from_export` -- kept from before this phase.
    2026-09-21 audit finding: an earlier version added these entries
    UNCONDITIONALLY, so a fixture with every optional field left null would
    still report them "confirmed". This proves the fix has teeth."""

    def test_confirmation_requires_a_real_non_null_source_value(self) -> None:
        impoverished = _fixture_bundle()
        impoverished.workspaces[0]["mission"] = None
        impoverished.workspaces[0]["internal_metadata"] = None
        impoverished.sessions[0]["internal_metadata"] = None
        for sp in impoverished.session_peers:
            sp["left_at"] = None
            sp["configuration"] = None
            sp["internal_metadata"] = None

        confirmed = confirm_fields_absent_from_export(impoverished)

        broken_by_null_source = {
            ("workspaces", "mission"),
            ("workspaces", "internal_metadata"),
            ("sessions", "internal_metadata"),
            ("session_peers", "left_at"),
            ("session_peers", "configuration"),
            ("session_peers", "internal_metadata"),
        }
        still_present = confirmed & broken_by_null_source
        self.assertEqual(still_present, set(), f"confirmed a field with no real source value to lose: {still_present}")


class TestFakeTargetEnforcesTheDocumentedSchema(unittest.TestCase):
    """The fake is only useful if it actually refuses what the real schema
    refuses -- otherwise it would let bundle.py bugs through silently. Every
    one of these checks is transcribed from `plastic-labs/honcho`'s pinned
    commit (see target.py's module docstring) -- re-checked 2026-09-26.
    """

    def test_rejects_client_supplied_token_count(self) -> None:
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_peer("ws", "p", {}, {})
        target.create_session("ws", "s", {}, {})
        with self.assertRaises(ValueError):
            target.create_messages("ws", "s", [{"content": "x", "peer_id": "p", "token_count": 5}])

    def test_rejects_client_supplied_message_id(self) -> None:
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_peer("ws", "p", {}, {})
        target.create_session("ws", "s", {}, {})
        with self.assertRaises(ValueError):
            target.create_messages("ws", "s", [{"content": "x", "peer_id": "p", "id": 99}])

    def test_rejects_session_peer_config_fields_outside_the_two_typed_booleans(self) -> None:
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_session("ws", "s", {}, {})
        with self.assertRaises(ValueError):
            target.add_session_peers("ws", "s", {"p": {"joined_at": "2026-09-21"}})

    def test_rejects_a_workspace_id_outside_the_resource_name_pattern(self) -> None:
        target = FakeHonchoTarget()
        with self.assertRaises(ValueError):
            target.create_workspace("m5:not-safe", {}, {})

    def test_rejects_more_than_100_messages_in_one_batch(self) -> None:
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_peer("ws", "p", {}, {})
        target.create_session("ws", "s", {}, {})
        too_many = [{"content": f"m{i}", "peer_id": "p"} for i in range(MESSAGE_BATCH_MAX + 1)]
        with self.assertRaises(ValueError):
            target.create_messages("ws", "s", too_many)
        # Exactly the cap is fine.
        target.create_messages("ws", "s", too_many[:MESSAGE_BATCH_MAX])

    def test_rejects_content_over_25000_chars(self) -> None:
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_peer("ws", "p", {}, {})
        target.create_session("ws", "s", {}, {})
        with self.assertRaises(TierOneLimitError):
            target.create_messages("ws", "s", [{"content": "x" * 25_001, "peer_id": "p"}])

    def test_rejects_metadata_over_100_top_level_keys(self) -> None:
        target = FakeHonchoTarget()
        too_wide = {f"k{i}": 1 for i in range(101)}
        with self.assertRaises(TierOneLimitError):
            target.create_workspace("ws", too_wide, {})

    def test_a_bare_datetime_in_a_message_payload_raises_like_a_real_http_call_would(self) -> None:
        """Issue #8 repro A, reproduced in-process: `requests`' `json=`
        encoder raises `TypeError` on a bare `datetime`. The fake forces the
        same JSON marshal boundary so this is caught here too."""

        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_peer("ws", "p", {}, {})
        target.create_session("ws", "s", {}, {})
        with self.assertRaises(TypeError):
            target.create_messages("ws", "s", [{"content": "x", "peer_id": "p", "created_at": T0}])

    def test_workspace_configuration_reserved_key_drops_an_unknown_sub_key(self) -> None:
        target = FakeHonchoTarget()
        row = target.create_workspace("ws", {}, {"peer_card": {"max_tokens": 500, "use": True}})
        self.assertEqual(row["configuration"], {"peer_card": {"use": True}})

    def test_peer_configuration_has_no_typed_shape_arbitrary_keys_survive(self) -> None:
        target = FakeHonchoTarget()
        row = target.create_peer("ws", "p", {}, {"peer_card": {"max_tokens": 500}})
        self.assertEqual(row["configuration"], {"peer_card": {"max_tokens": 500}})


class TestLiveRoundTrip(unittest.TestCase):
    """The live leg. Executed ONLY if HONCHO_ROUNDTRIP_LIVE_BASE_URL points
    at a real, disposable instance the caller stood up per pin.HONCHO_V3_2_0
    (see docker/ next to this test's package for the manual compose steps --
    this test never starts a container itself, and never points at
    white.local or any shared instance).
    """

    def test_round_trip_against_a_real_pinned_honcho_instance(self) -> None:
        base_url = os.environ.get("HONCHO_ROUNDTRIP_LIVE_BASE_URL")
        if not base_url:
            self.skipTest(
                "HONCHO_ROUNDTRIP_LIVE_BASE_URL not set -- live leg UNEXECUTED. "
                "In this session: no container runtime is available (`docker ps` "
                "fails, colima is not running) and the shared white.local instance "
                "is explicitly ruled out as a target by issue #8's 2026-09-20 scope "
                "correction. See app/migrate-py/src/arra_migrate/honcho_roundtrip/"
                "docker/README.md for how to bring up the pinned instance and set "
                "this variable to run this leg for real."
            )
        if "white.local" in base_url:
            self.fail("HONCHO_ROUNDTRIP_LIVE_BASE_URL must never point at the shared white.local instance")

        root = Path(tempfile.mkdtemp(prefix="arra-honcho-rt-live-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        bank = build_spec_15_5_bank(root)
        target = HttpHonchoTarget(base_url)
        export_to_honcho(target, bank)
        export = export_from_honcho(target, WORKSPACE_NAME, SESSION_NAMES)
        returned = honcho_to_bundle(export, WORKSPACE_NAME)
        report = diff_against_input(bank, returned)
        self.assertEqual(report.problems, [], report.problems)


if __name__ == "__main__":
    unittest.main()
