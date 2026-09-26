"""Timestamp wire encoding for the Honcho REST leg. Issue #8.

v4's tier-1 ``created_at`` columns are naive ``timestamp[us]`` -- naive means
UTC by the ``LanceModel`` convention (see ``rehearsal.py``'s ``T0`` comment),
never local time. Sending that ``datetime`` object straight into
``requests.post(json=...)`` is exactly the defect measured on this issue
(``.tmp/understand/issue-8/repro_output.txt`` finding A: ``TypeError: Object
of type datetime is not JSON serializable`` -- ``json.dumps`` has no default
encoder for ``datetime``). ``MessageCreate.created_at`` on the Honcho side is a
real ``datetime.datetime`` field (``src/schemas/api.py``), and pydantic v2
parses an RFC 3339 string with a trailing ``Z`` as UTC without help -- so the
fix is to encode before the request leaves this process, not to lean on any
implicit conversion at the far end.

``to_wire_timestamp`` refuses a sub-millisecond value rather than silently
truncating it, matching ruling R1 (``docs/overnight/DECISIONS.md``): a v4
tier-1 timestamp carrying sub-millisecond precision is a producer defect that
must fail closed, not a legitimate value this encoder should quietly narrow.
"""

from __future__ import annotations

from datetime import datetime, timezone


class SubMillisecondTimestampError(ValueError):
    """A v4 tier-1 timestamp carries sub-millisecond precision. Per ruling R1
    this is a producer defect (a v4 invariant violation), not a value this
    encoder may narrow -- silently truncating it would hide the same class of
    bug #105 was."""


def to_wire_timestamp(value: datetime) -> str:
    """RFC 3339, millisecond precision, always ``Z`` -- never a bare offset and
    never a naive string. A naive ``value`` is *assumed* UTC (the v4
    convention), not treated as local time. Raises ``SubMillisecondTimestampError``
    rather than truncating if *value* carries sub-millisecond precision."""

    aware = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    aware = aware.astimezone(timezone.utc)
    if aware.microsecond % 1000 != 0:
        raise SubMillisecondTimestampError(
            f"{value!r} carries sub-millisecond precision ({aware.microsecond} µs) -- "
            "per ruling R1 this is a producer defect that must fail closed, not be truncated"
        )
    return aware.strftime("%Y-%m-%dT%H:%M:%S.") + f"{aware.microsecond // 1000:03d}Z"


def from_wire_timestamp(raw: str) -> datetime:
    """Parse a timestamp Honcho returned (RFC 3339, ``Z`` or ``+00:00``) back
    into a UTC-aware ``datetime``, regardless of which spelling came back."""

    text = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
