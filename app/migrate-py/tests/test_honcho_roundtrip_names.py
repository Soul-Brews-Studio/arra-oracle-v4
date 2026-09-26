"""Reversible name encoding for Honcho's RESOURCE_NAME_PATTERN. Issue #8, ruling R15.

Honcho v3.2.0 refuses any workspace/peer/session id outside
``^[a-zA-Z0-9_-]+$`` (measured, `.tmp/understand/issue-8/repro_output.txt`
finding F: a federation-tagged peer name like ``m5:arra-oracle-v3`` is refused
outright). v4 names are unconstrained. `names.honcho_name` /
`names.decode_honcho_name` must be a true bijection over every name v4 can
actually produce, not just the common case.
"""

from __future__ import annotations

import unittest

from arra_migrate.honcho_roundtrip.names import (
    ENCODED_NAME_PREFIX,
    RESOURCE_NAME_MAX_LENGTH,
    RESOURCE_NAME_PATTERN,
    UnrepresentableNameError,
    decode_honcho_name,
    honcho_name,
)


class NameEncodingRoundTripTests(unittest.TestCase):
    REPRESENTATIVE_NAMES = (
        "nat",
        "safe_name-123",
        "m5:arra-oracle-v3",             # the federation-tagged peer name from the issue.
        "ห้องทดลอง",                        # Thai text -- multi-byte UTF-8.
        "ภาษาไทย 🌱 ทดสอบ",                 # Thai + an astral-plane emoji.
        "",                              # will fail wire-safety (pattern requires min_length=1 upstream, but must still round-trip through the encoder itself for defense in depth)
        ENCODED_NAME_PREFIX + "already-looks-encoded",  # the anti-collision case.
        ENCODED_NAME_PREFIX,             # bare prefix, nothing after it.
        "a" * RESOURCE_NAME_MAX_LENGTH,  # exactly at the limit, safe charset.
    )

    def test_every_representative_name_round_trips_exactly(self) -> None:
        for name in self.REPRESENTATIVE_NAMES:
            with self.subTest(name=name):
                encoded = honcho_name(name)
                self.assertEqual(decode_honcho_name(encoded), name)

    def test_every_encoded_name_satisfies_honchos_pattern(self) -> None:
        for name in self.REPRESENTATIVE_NAMES:
            with self.subTest(name=name):
                encoded = honcho_name(name)
                self.assertTrue(
                    RESOURCE_NAME_PATTERN.fullmatch(encoded),
                    f"{encoded!r} does not match {RESOURCE_NAME_PATTERN.pattern!r}",
                )
                self.assertLessEqual(len(encoded), RESOURCE_NAME_MAX_LENGTH)

    def test_a_name_already_safe_is_sent_unchanged(self) -> None:
        # Identity, not merely round-trippable -- an unnecessary re-encoding
        # would still be correct but would make every safe v4 name unreadable
        # in a live Honcho admin view for no reason.
        self.assertEqual(honcho_name("nat"), "nat")
        self.assertEqual(honcho_name("safe_name-123"), "safe_name-123")

    def test_a_name_starting_with_the_reserved_prefix_is_still_encoded(self) -> None:
        # The anti-collision clause: a name that is ALREADY wire-safe but
        # happens to start with ENCODED_NAME_PREFIX must not be sent as-is,
        # or it becomes indistinguishable from a genuinely encoded name on
        # decode.
        tricky = ENCODED_NAME_PREFIX + "not-actually-base64!!"
        encoded = honcho_name(tricky)
        self.assertNotEqual(encoded, tricky)
        self.assertEqual(decode_honcho_name(encoded), tricky)

    def test_two_different_inputs_never_encode_to_the_same_wire_name(self) -> None:
        seen: dict[str, str] = {}
        for name in self.REPRESENTATIVE_NAMES:
            encoded = honcho_name(name)
            if encoded in seen:
                self.assertEqual(seen[encoded], name, f"collision: {name!r} and {seen[encoded]!r} both encode to {encoded!r}")
            seen[encoded] = name

    def test_a_name_that_cannot_fit_once_encoded_is_refused_not_truncated(self) -> None:
        # UTF-8 + base64 expansion pushes a long, entirely non-ASCII name past
        # the 512-char limit -- must raise, never silently truncate (a
        # truncated name is a DIFFERENT name, not the same one shortened).
        too_long = "ก" * 400  # 3 bytes/char in UTF-8 -> well past 512 once base64-expanded.
        with self.assertRaises(UnrepresentableNameError):
            honcho_name(too_long)


if __name__ == "__main__":
    unittest.main()
