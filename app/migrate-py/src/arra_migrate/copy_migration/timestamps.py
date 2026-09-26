"""Exact time handling for the copy. Reject, never round.

Legacy ``timestamp[us]`` columns arrive from pyarrow as naive datetimes that
keep every microsecond. The target codecs accept only millisecond-exact
values (``rows.timestampToMicros``, ``context.storedTimestamp``), so a
sub-millisecond value is a REJECTED record with a report entry -- the same
rule ``mapLegacyMessageBoundary`` applies. Rounding would assert a time the
source never held.

Int64 epoch-MILLISECOND columns (``traces.*_ts``/``created_at``/``updated_at``,
``mcp_calls.created_at``) are retained raw: no unit is reinterpreted.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from typing import Any

from ..contract_v1 import parse_timestamp

EPOCH = datetime(1970, 1, 1)  # noqa: DTZ001 -- naive UTC, the LanceModel/Arrow convention


def is_ms_exact(value: datetime) -> bool:
    return value.microsecond % 1000 == 0


def first_sub_ms(row: dict[str, Any], fields: Iterable[str]) -> str | None:
    """The first named timestamp field holding a sub-millisecond value."""

    for name in fields:
        value = row.get(name)
        if isinstance(value, datetime) and not is_ms_exact(value):
            return name
    return None


def epoch_ms(value: datetime) -> int:
    """Exact epoch milliseconds of an ms-exact naive-UTC datetime."""

    if not is_ms_exact(value):
        raise ValueError("not millisecond-exact")
    return (value - EPOCH) // timedelta(milliseconds=1)


def iso_ms(value: datetime | None) -> str | None:
    """The wire form ``YYYY-MM-DDTHH:MM:SS.sssZ`` of an ms-exact datetime."""

    if value is None:
        return None
    if not is_ms_exact(value):
        raise ValueError("not millisecond-exact")
    return (
        f"{value.year:04d}-{value.month:02d}-{value.day:02d}T"
        f"{value.hour:02d}:{value.minute:02d}:{value.second:02d}.{value.microsecond // 1000:03d}Z"
    )


def parse_intake(text: str) -> datetime:
    """The frozen migration intake time, exact UTC milliseconds, naive for Arrow."""

    return parse_timestamp(text).astimezone(timezone.utc).replace(tzinfo=None)
