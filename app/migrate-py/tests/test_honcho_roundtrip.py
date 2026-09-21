"""§15.5 round-trip test tier. Issue #8.

Two legs, reported honestly as two different things:

  * ``TestExecutedFixtureRoundTrip`` -- ACTUALLY RUNS, against
    ``FakeHonchoTarget``, which encodes the verified v3.2.0 schema
    constraints (see ``target.py``'s module docstring for the citations).
    This proves the export/import/diff LOGIC in ``bundle.py`` is correct
    given that documented behaviour.
  * ``TestLiveRoundTrip`` -- would run the SAME assertions against a real,
    pinned Honcho process (``pin.HONCHO_V3_2_0``) if
    ``HONCHO_ROUNDTRIP_LIVE_BASE_URL`` is set. In this session it is
    UNEXECUTED: no container runtime is available (`docker ps` fails --
    colima is not running, this repo cannot start it) and the shared
    white.local instance is explicitly ruled out as a target by the issue's
    2026-09-20 scope correction. The test SKIPS with that reason printed,
    it does not silently pass and it does not fall back to a live target
    that was never authorized.
"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone

from arra_migrate.honcho_roundtrip.bundle import (
    LOSSY_FIELDS,
    LOSSY_FIELDS_BY_CONSTRUCTION,
    Tier1Bundle,
    confirm_fields_absent_from_export,
    export_from_honcho,
    export_to_honcho,
    verify_round_trip,
)
from arra_migrate.honcho_roundtrip.target import FakeHonchoTarget, HttpHonchoTarget

T0 = datetime(2026, 9, 21, 9, 0, 0, tzinfo=timezone.utc)


def _fixture_bundle() -> Tier1Bundle:
    """Deterministic tier-1 rows in v4's own field shape (see
    arra_migrate.models.{workspace,peer,session,session_peer,message}).
    Includes: Thai content, the four +v4 nullable message columns (role,
    in_reply_to, read, read_at), and non-null session_peers columns
    (joined_at, left_at, configuration, internal_metadata) -- every field
    this round trip claims is lossy needs at least one non-null source
    value in THIS fixture, or `confirm_fields_absent_from_export` correctly
    refuses to confirm it (see that function's docstring / the 2026-09-21
    audit finding it fixes).
    """

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
            # nat: still in the session -- exercises configuration/internal_metadata non-null.
            {"workspace_name": "ws-roundtrip", "session_name": "session-one", "peer_name": "nat",
             "configuration": '{"pinned": true}', "internal_metadata": '{"joined_via": "test"}',
             "joined_at": T0, "left_at": None},
            # neo: LEFT the session -- exercises left_at non-null (Principle 1: leaving is a timestamp).
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
    """Runs for real, against FakeHonchoTarget. This is the "did the logic
    hold given the documented schema" leg, not "did a real server agree".
    """

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

    def test_every_declared_lossy_field_is_actually_confirmed_not_just_asserted(self) -> None:
        """A LOSSY_FIELDS entry must be either MEASURED against this
        fixture's actual data (`lossy_fields_confirmed`) or explicitly
        marked as unmeasurable by construction (`lossy_fields_by_construction`,
        exactly `LOSSY_FIELDS_BY_CONSTRUCTION` -- nothing "confirmed" is
        allowed to double as "by construction", or the distinction is
        meaningless). Fails if any declared entry is covered by neither.
        """
        export_to_honcho(self.target, self.bundle)
        first = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        second = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        report = verify_round_trip(self.bundle, first, second)
        declared = {(f.table, f.field) for f in LOSSY_FIELDS}
        covered = report.lossy_fields_confirmed | report.lossy_fields_by_construction
        missing = declared - covered
        self.assertEqual(missing, set(), f"declared lossy but never exercised by this fixture: {missing}")
        overlap = report.lossy_fields_confirmed & report.lossy_fields_by_construction
        self.assertEqual(overlap, set(), f"a field cannot be both measured and unmeasurable-by-construction: {overlap}")
        self.assertEqual(report.lossy_fields_by_construction, LOSSY_FIELDS_BY_CONSTRUCTION)

    def test_bite_confirmation_requires_a_real_non_null_source_value(self) -> None:
        """The 2026-09-21 audit finding, made concrete: an earlier version of
        `verify_round_trip` added workspaces.mission (and eight other
        entries) to `lossy_fields_confirmed` UNCONDITIONALLY, regardless of
        whether the fixture had a real value to lose. Break the precondition
        here -- null out every optional field the confirmed-by-measurement
        path depends on -- and prove the SAME check this test suite relies on
        would then correctly refuse to confirm them.
        """
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

        # And the exhaustiveness test WOULD fail on this impoverished bundle
        # -- proving the assertion in
        # test_every_declared_lossy_field_is_actually_confirmed_not_just_asserted
        # has teeth, not just against a hypothetical, against the exact
        # mechanism this file uses.
        export_to_honcho(self.target, impoverished)
        first = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        second = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        report = verify_round_trip(impoverished, first, second)
        declared = {(f.table, f.field) for f in LOSSY_FIELDS}
        covered = report.lossy_fields_confirmed | report.lossy_fields_by_construction
        missing = declared - covered
        self.assertTrue(missing & broken_by_null_source, f"expected the impoverished bundle to leave {broken_by_null_source} unconfirmed, got missing={missing}")

    def test_folded_v4_message_fields_survive_inside_metadata(self) -> None:
        export_to_honcho(self.target, self.bundle)
        export = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        by_content = {m["content"]: m for m in export.messages}
        reply = by_content["reply"]
        self.assertEqual(
            reply["metadata"]["_v4"],
            {"role": "answer", "in_reply_to": "msg-pub-01", "read": True, "read_at": T0},
        )
        note = by_content["ภาษาไทย 🌱 ทดสอบ round trip"]
        # role="note" is the only non-null +v4 field on this message.
        self.assertEqual(note["metadata"]["_v4"], {"role": "note"})
        self.assertNotIn("note", note["metadata"])  # this message's own h_metadata was None
        # h_metadata content on the OTHER message is preserved alongside its
        # fold, not overwritten by it -- the two keys must coexist.
        self.assertEqual(reply["metadata"].get("note"), "kept")

    def test_v4_internal_ids_and_internal_metadata_never_reach_the_target(self) -> None:
        """Positive control: if bundle.py started leaking these, this would
        catch it, since FakeHonchoTarget raises on an unexpected id/token_count
        key and the real schema has nowhere to put internal_metadata anyway.
        """
        export_to_honcho(self.target, self.bundle)  # must not raise
        export = export_from_honcho(self.target, self.workspace_id, self.session_ids)
        for peer in export.peers:
            self.assertNotIn("internal_metadata", peer)
        for msg in export.messages:
            self.assertNotIn("internal_metadata", msg)


class TestFakeTargetEnforcesTheDocumentedSchema(unittest.TestCase):
    """The fake is only useful if it actually refuses what the real schema
    refuses -- otherwise it would let bundle.py bugs through silently.
    """

    def test_rejects_client_supplied_token_count(self) -> None:
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_peer("ws", "p", {}, {})
        target.create_session("ws", "s", {})
        with self.assertRaises(ValueError):
            target.create_messages("ws", "s", [{"content": "x", "peer_id": "p", "token_count": 5}])

    def test_rejects_client_supplied_message_id(self) -> None:
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_peer("ws", "p", {}, {})
        target.create_session("ws", "s", {})
        with self.assertRaises(ValueError):
            target.create_messages("ws", "s", [{"content": "x", "peer_id": "p", "id": 99}])

    def test_rejects_session_peer_config_fields_outside_the_two_typed_booleans(self) -> None:
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_session("ws", "s", {})
        with self.assertRaises(ValueError):
            target.add_session_peers("ws", "s", {"p": {"joined_at": "2026-09-21"}})


class TestLiveRoundTrip(unittest.TestCase):
    """The live leg. Executed ONLY if HONCHO_ROUNDTRIP_LIVE_BASE_URL points
    at a real, disposable instance the caller stood up per pin.HONCHO_V3_2_0
    (see docker/ next to this test's package for the manual compose steps --
    this test never starts a container itself).
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
        bundle = _fixture_bundle()
        target = HttpHonchoTarget(base_url)
        export_to_honcho(target, bundle)
        first = export_from_honcho(target, "ws-roundtrip", ["session-one"])
        second = export_from_honcho(target, "ws-roundtrip", ["session-one"])
        report = verify_round_trip(bundle, first, second)
        self.assertEqual(report.problems, [], report.problems)


if __name__ == "__main__":
    unittest.main()
