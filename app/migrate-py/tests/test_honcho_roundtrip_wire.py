"""`wire.to_wire_timestamp`'s fail-closed sub-millisecond check. Issue #8,
ruling R1 (2026-09-26 fix-round finding).

Ruling R1 (`docs/overnight/DECISIONS.md`) treats a sub-millisecond v4 tier-1
timestamp as a producer defect that must fail closed, not a value a
downstream consumer may quietly narrow -- exactly the class of bug #105 was.
Before this fix round, `to_wire_timestamp` truncated silently instead.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from arra_migrate.honcho_roundtrip.wire import (
    SubMillisecondTimestampError,
    from_wire_timestamp,
    to_wire_timestamp,
)


class ToWireTimestampTests(unittest.TestCase):
    def test_a_millisecond_aligned_value_encodes_normally(self) -> None:
        value = datetime(2026, 9, 26, 21, 0, 0, 250_000, tzinfo=timezone.utc)
        self.assertEqual(to_wire_timestamp(value), "2026-09-26T21:00:00.250Z")

    def test_a_naive_value_is_assumed_utc(self) -> None:
        value = datetime(2026, 9, 26, 21, 0, 0, 0)
        self.assertEqual(to_wire_timestamp(value), "2026-09-26T21:00:00.000Z")

    def test_a_sub_millisecond_value_is_refused_not_truncated(self) -> None:
        # 250123 microseconds -- not a whole number of milliseconds. Ruling R1:
        # this is a producer defect and must fail closed, never be rounded.
        value = datetime(2026, 9, 26, 21, 0, 0, 250_123, tzinfo=timezone.utc)
        with self.assertRaises(SubMillisecondTimestampError):
            to_wire_timestamp(value)

    def test_a_sub_millisecond_naive_value_is_also_refused(self) -> None:
        value = datetime(2026, 9, 26, 21, 0, 0, 1)
        with self.assertRaises(SubMillisecondTimestampError):
            to_wire_timestamp(value)

    def test_round_trip_through_from_wire_timestamp_is_exact_for_a_valid_value(self) -> None:
        value = datetime(2026, 9, 26, 21, 0, 0, 250_000, tzinfo=timezone.utc)
        self.assertEqual(from_wire_timestamp(to_wire_timestamp(value)), value)


if __name__ == "__main__":
    unittest.main()
