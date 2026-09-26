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
"""

from __future__ import annotations

from datetime import datetime, timezone


def to_wire_timestamp(value: datetime) -> str:
    """RFC 3339, millisecond precision, always ``Z`` -- never a bare offset and
    never a naive string. A naive ``value`` is *assumed* UTC (the v4
    convention), not treated as local time."""

    aware = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    aware = aware.astimezone(timezone.utc)
    return aware.strftime("%Y-%m-%dT%H:%M:%S.") + f"{aware.microsecond // 1000:03d}Z"


def from_wire_timestamp(raw: str) -> datetime:
    """Parse a timestamp Honcho returned (RFC 3339, ``Z`` or ``+00:00``) back
    into a UTC-aware ``datetime``, regardless of which spelling came back."""

    text = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
