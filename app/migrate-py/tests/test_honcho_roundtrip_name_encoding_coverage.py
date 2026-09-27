"""Round-trip name-encoding mutation coverage -- issue #8, ruling R15, 2026-09-26
fix round two.

An independent Opus verifier applied five mutations to `bundle.py`/`diff.py`,
one at a time, at 999c2bd, and the whole suite (`Ran 79 tests ... OK
(skipped=1)`) stayed green for every one of them:

  MV2  bundle.py:205 sends the raw SESSION name as `id` (drops `names.honcho_name`)
  MV3  bundle.py:189 sends the raw WORKSPACE name as `id` (same, workspace side)
  MV4  bundle.py:314 calls `create_messages` with the raw workspace/session NAME,
       not the encoded wire id
  MV   bundle.py:237 sends the raw message `peer_id` (the author), not encoded
  MV5  diff.py:132 stops decoding `session_id` back to a v4 name in `honcho_to_bundle`

Root cause, from the verifier's own probe: every existing round-trip
fixture's WORKSPACE and SESSION names already satisfy
`names.RESOURCE_NAME_PATTERN` (`ws-spec-15-5`, `session-one`/`session-two`),
so `honcho_name` is the IDENTITY on them -- dropping the call changes nothing
observable. The one existing invalid-pattern name,
`dump.FEDERATION_PEER_NAME = "m5:arra-oracle-v3"`, IS already used as a
message author in the SPEC bank, but `FakeHonchoTarget.create_messages` never
validated the author id (unlike every other `create_*` method there) and
`decode_honcho_name` is the identity on a name that was never encoded in the
first place -- so a raw, un-encoded author compares clean against itself on
the way back too.

This module adds the missing fixture (a workspace and a session name that
fail the pattern -- the same shapes the verifier's own probe used:
`'ห้องทดลอง'`, `'ห้อง:หนึ่ง'`, `'m5:neo.oracle'`) and asserts on the WIRE
value directly (`export_from_honcho`'s raw `HonchoExport`, before
`honcho_to_bundle` decodes anything) as well as on the final diff -- so each
test below fails with a specific, attributable mismatch when the ONE
`names.honcho_name`/`names.decode_honcho_name` call it targets is removed
(verified 2026-09-26 in a scratch copy at 999c2bd; see this fix round's
structured result for which test went red under which mutation).

`target.FakeHonchoTarget.create_messages` was also fixed to validate the
author id against `RESOURCE_NAME_PATTERN` (mirroring every other `create_*`
method there, and pinned Honcho's own `crud/message.py:419-422` ->
`crud/peer.py:85-105 _validate_new_peer_names`) -- see
`FakeAuthorNameValidationTests` below, which is red before that fix.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from arra_migrate.honcho_roundtrip import names
from arra_migrate.honcho_roundtrip.bundle import (
    Tier1Bundle,
    export_from_honcho,
    export_to_honcho,
)
from arra_migrate.honcho_roundtrip.diff import diff_against_input, honcho_to_bundle
from arra_migrate.honcho_roundtrip.target import FakeHonchoTarget

T0 = datetime(2026, 9, 26, 23, 0, 0, tzinfo=timezone.utc)

# The verifier's own probe names (2026-09-26 fix-round finding) -- none of
# these satisfy `names.RESOURCE_NAME_PATTERN`.
WORKSPACE_NAME = "ห้องทดลอง"
SESSION_NAME = "ห้อง:หนึ่ง"
AUTHOR_NAME = "m5:neo.oracle"
PLAIN_PEER_NAME = "nat"  # safe-pattern control, so the fixture isn't ALL non-ASCII


def _non_pattern_names_bundle() -> Tier1Bundle:
    """One workspace, one session, two peers, two messages -- every name that
    CAN fail `RESOURCE_NAME_PATTERN` (workspace, session, message author)
    actually does, so a dropped `names.honcho_name`/`decode_honcho_name` call
    anywhere in that chain is observable, not masked by coincidence."""

    return Tier1Bundle(
        workspaces=[{
            "id": "ws-01", "name": WORKSPACE_NAME, "created_at": T0,
            "h_metadata": None, "internal_metadata": None, "configuration": None, "mission": None,
        }],
        peers=[
            {"id": "peer-01", "name": PLAIN_PEER_NAME, "workspace_name": WORKSPACE_NAME,
             "h_metadata": None, "internal_metadata": None, "configuration": None, "created_at": T0},
            {"id": "peer-02", "name": AUTHOR_NAME, "workspace_name": WORKSPACE_NAME,
             "h_metadata": None, "internal_metadata": None, "configuration": None, "created_at": T0},
        ],
        sessions=[{
            "id": "sess-01", "name": SESSION_NAME, "workspace_name": WORKSPACE_NAME,
            "is_active": True, "h_metadata": None, "internal_metadata": None,
            "configuration": None, "created_at": T0,
        }],
        session_peers=[
            {"workspace_name": WORKSPACE_NAME, "session_name": SESSION_NAME, "peer_name": PLAIN_PEER_NAME,
             "configuration": None, "internal_metadata": None, "joined_at": T0, "left_at": None},
            {"workspace_name": WORKSPACE_NAME, "session_name": SESSION_NAME, "peer_name": AUTHOR_NAME,
             "configuration": None, "internal_metadata": None, "joined_at": T0, "left_at": None},
        ],
        messages=[
            {"id": 1, "public_id": "msg-pub-01", "workspace_name": WORKSPACE_NAME,
             "session_name": SESSION_NAME, "peer_name": PLAIN_PEER_NAME, "content": "welcome to the room",
             "token_count": 3, "seq_in_session": 1, "h_metadata": None, "internal_metadata": None,
             "created_at": T0, "role": None, "in_reply_to": None, "read": None, "read_at": None},
            {"id": 2, "public_id": "msg-pub-02", "workspace_name": WORKSPACE_NAME,
             "session_name": SESSION_NAME, "peer_name": AUTHOR_NAME, "content": "observing from the fold",
             "token_count": 3, "seq_in_session": 2, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(seconds=1), "role": None, "in_reply_to": None, "read": None, "read_at": None},
        ],
    )


def _round_trip(bundle: Tier1Bundle):
    """Returns (raw HonchoExport, decoded Tier1Bundle, DiffReport) -- the raw
    export is what the WIRE-level assertions below need; `honcho_to_bundle`
    already discards it in favour of decoded names."""

    target = FakeHonchoTarget()
    export_to_honcho(target, bundle)
    export = export_from_honcho(target, WORKSPACE_NAME, [SESSION_NAME])
    returned = honcho_to_bundle(export, WORKSPACE_NAME)
    report = diff_against_input(bundle, returned)
    return export, returned, report


class NonPatternNamesRoundTripTests(unittest.TestCase):
    """The R15 name encoding, exercised on WORKSPACE and SESSION names for the
    first time (see this module's own docstring) -- not only the peer name
    `test_honcho_roundtrip_names.py` and the SPEC bank's `FEDERATION_PEER_NAME`
    already covered."""

    def setUp(self) -> None:
        self.bank = _non_pattern_names_bundle()

    def test_full_round_trip_has_no_problems(self) -> None:
        _export, _returned, report = _round_trip(self.bank)
        self.assertEqual(report.problems, [], report.problems)

    def test_workspace_id_on_the_wire_is_encoded_not_the_raw_name(self) -> None:
        """Kills mutation MV3 (bundle.py:189, `_workspace_payload` sends
        `ws["name"]` raw): if the encoding call is dropped, `export.workspace
        ["id"]` comes back equal to the raw Thai name instead of
        `names.honcho_name(WORKSPACE_NAME)`."""

        export, _returned, _report = _round_trip(self.bank)
        self.assertEqual(export.workspace["id"], names.honcho_name(WORKSPACE_NAME))
        self.assertNotEqual(export.workspace["id"], WORKSPACE_NAME)

    def test_session_id_on_the_wire_is_encoded_not_the_raw_name(self) -> None:
        """Kills mutation MV2 (bundle.py:205, `_session_payload` sends
        `sess["name"]` raw)."""

        export, _returned, _report = _round_trip(self.bank)
        session_ids = {s["id"] for s in export.sessions}
        self.assertIn(names.honcho_name(SESSION_NAME), session_ids)
        self.assertNotIn(SESSION_NAME, session_ids)

    def test_message_author_id_on_the_wire_is_encoded_not_the_raw_name(self) -> None:
        """Kills mutation MV (bundle.py:237, `_message_payload` sends
        `msg["peer_name"]` raw as `peer_id`)."""

        export, _returned, _report = _round_trip(self.bank)
        by_content = {m["content"]: m for m in export.messages}
        observed = by_content["observing from the fold"]
        self.assertEqual(observed["peer_id"], names.honcho_name(AUTHOR_NAME))
        self.assertNotEqual(observed["peer_id"], AUTHOR_NAME)

    def test_all_messages_land_under_the_encoded_session_not_an_orphan_bucket(self) -> None:
        """Kills mutation MV4 (bundle.py:314, `export_to_honcho`'s
        message-sending loop calls `target.create_messages` with the raw
        workspace/session NAME instead of `names.honcho_name(...)`): the
        session was already created under the ENCODED id, so messages sent
        under the raw name would land in a bucket `export_from_honcho` (which
        always asks for the encoded id) never reads back -- `export.messages`
        would come back empty instead of 2."""

        export, _returned, _report = _round_trip(self.bank)
        self.assertEqual(len(export.messages), 2, export.messages)

    def test_message_session_name_decodes_back_to_the_original_not_the_wire_id(self) -> None:
        """Kills mutation MV5 (diff.py:132, `honcho_to_bundle` stops calling
        `names.decode_honcho_name` on `m["session_id"]`): the returned bundle
        would group messages under the ENCODED wire id (`hnb64-...`) instead
        of the real session name."""

        _export, returned, _report = _round_trip(self.bank)
        session_names = {m["session_name"] for m in returned.messages}
        self.assertEqual(session_names, {SESSION_NAME}, session_names)


class FakeAuthorNameValidationTests(unittest.TestCase):
    """2026-09-26 fix-round finding: `FakeHonchoTarget.create_messages` never
    validated the message author id against `RESOURCE_NAME_PATTERN`, unlike
    every OTHER `create_*` method on this class (`create_workspace`,
    `create_peer`, `create_session`, `add_session_peers` all call
    `_check_resource_name`). Pinned Honcho's `crud/message.py:419-422`
    get_or_creates the author peer via `crud/peer.py:85-105
    _validate_new_peer_names`, which raises on a name outside the pattern --
    a real Honcho 422 this Fake did not reproduce. This gap is WHY mutation MV
    (see this module's docstring) was invisible to a diff-only test: a raw,
    un-encoded author name sailed through the Fake unchanged, and
    `decode_honcho_name` is the identity on a name that was never encoded, so
    it compared clean against the original. Red before the `target.py` fix,
    green after."""

    def test_create_messages_rejects_an_author_id_outside_the_resource_name_pattern(self) -> None:
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_session("ws", "s", {}, {})
        with self.assertRaises(ValueError):
            target.create_messages("ws", "s", [{"content": "x", "peer_id": "m5:not-safe"}])

    def test_an_encoded_author_id_is_still_accepted(self) -> None:
        # The fix must not become a false-positive rejection of the encoded
        # form every real caller (via `bundle._message_payload`) actually sends.
        target = FakeHonchoTarget()
        target.create_workspace("ws", {}, {})
        target.create_session("ws", "s", {}, {})
        target.create_messages("ws", "s", [{"content": "x", "peer_id": names.honcho_name(AUTHOR_NAME)}])  # must not raise


if __name__ == "__main__":
    unittest.main()
