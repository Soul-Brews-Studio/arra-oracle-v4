"""Candidate v1 physical codecs for cross-language contract tests.

This module defines encodings only. It does not migrate data or install these
candidate codecs into the application runtime.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
_ID_PATTERN = re.compile(r"\A[A-Za-z0-9_-]{21}\Z")
_INT64_PATTERN = re.compile(r"\A(?:0|-[1-9][0-9]*|[1-9][0-9]*)\Z")
_TIMESTAMP_PATTERN = re.compile(
    r"\A([0-9]{4})-([0-9]{2})-([0-9]{2})"
    r"T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z\Z"
)

_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1

_MESSAGE_FIELDS = (
    "source_namespace",
    "source_message_id",
    "peer_name",
    "role",
    "content",
    "source_created_at",
    "in_reply_to",
)
_MESSAGE_FIELD_SET = frozenset(_MESSAGE_FIELDS)
_DIGEST_DOMAIN = b"arra-message/v1\n"


def new_id() -> str:
    """Return a cryptographically random 21-character URL-safe identifier."""

    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(21))


def validate_id(value: str) -> str:
    """Return *value* unchanged when it is a valid candidate v1 identifier."""

    if not isinstance(value, str) or _ID_PATTERN.fullmatch(value) is None:
        raise ValueError("ID must contain exactly 21 URL-safe ASCII characters")
    return value


def parse_int64(value: str) -> int:
    """Parse the canonical decimal representation of a signed 64-bit integer."""

    if not isinstance(value, str) or len(value) > 20 or _INT64_PATTERN.fullmatch(value) is None:
        raise ValueError("int64 must be a canonical decimal string")

    parsed = int(value)
    if parsed < _INT64_MIN or parsed > _INT64_MAX:
        raise ValueError("int64 is outside the signed 64-bit range")
    return parsed


def format_int64(value: int) -> str:
    """Format a signed 64-bit integer as canonical decimal text."""

    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("int64 value must be an integer, not bool")  # noqa: TRY004 - one validation exception for all codec rejection
    if value < _INT64_MIN or value > _INT64_MAX:
        raise ValueError("int64 is outside the signed 64-bit range")
    return str(value)


def parse_timestamp(value: str) -> datetime:
    """Parse the exact ``YYYY-MM-DDTHH:mm:ss.SSSZ`` UTC representation."""

    if not isinstance(value, str):
        raise ValueError("timestamp must be a string")  # noqa: TRY004 - one validation exception for all codec rejection

    match = _TIMESTAMP_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError("timestamp must use YYYY-MM-DDTHH:mm:ss.SSSZ")

    year, month, day, hour, minute, second, millisecond = map(int, match.groups())
    if year == 0:
        raise ValueError("timestamp year must be between 0001 and 9999")
    try:
        return datetime(
            year,
            month,
            day,
            hour,
            minute,
            second,
            millisecond * 1000,
            tzinfo=timezone.utc,
        )
    except ValueError as error:
        raise ValueError("timestamp contains an invalid calendar value") from error


def format_timestamp(value: datetime) -> str:
    """Format an aware UTC datetime with exact millisecond precision."""

    if not isinstance(value, datetime):
        raise ValueError("timestamp value must be a datetime")  # noqa: TRY004 - one validation exception for all codec rejection
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("timestamp datetime must be aware and UTC")
    if value.microsecond % 1000 != 0:
        raise ValueError("timestamp datetime must have millisecond precision")

    return (
        f"{value.year:04d}-{value.month:02d}-{value.day:02d}"
        f"T{value.hour:02d}:{value.minute:02d}:{value.second:02d}"
        f".{value.microsecond // 1000:03d}Z"
    )


def canonical_message(payload: Mapping[str, Any]) -> bytes:
    """Validate and encode the closed candidate v1 source-message envelope."""

    if not isinstance(payload, Mapping):
        raise ValueError("message payload must be a mapping")  # noqa: TRY004 - one validation exception for all codec rejection
    if len(payload) != len(_MESSAGE_FIELDS) or set(payload) != _MESSAGE_FIELD_SET:
        raise ValueError("message payload must contain exactly the v1 fields")

    _require_nonempty_string(payload["source_namespace"], "source_namespace")
    _require_nonempty_string(payload["source_message_id"], "source_message_id")
    _require_nonempty_string(payload["peer_name"], "peer_name")
    _require_nullable_string(payload["role"], "role")
    _require_string(payload["content"], "content")
    _require_nullable_string(payload["in_reply_to"], "in_reply_to")

    source_created_at = payload["source_created_at"]
    if source_created_at is not None:
        _require_string(source_created_at, "source_created_at")
        parse_timestamp(source_created_at)

    ordered = {field: payload[field] for field in _MESSAGE_FIELDS}
    encoded = json.dumps(
        ordered,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return encoded.encode("utf-8")


def message_digest(payload: Mapping[str, Any]) -> str:
    """Hash a canonical v1 source-message envelope with domain separation."""

    return hashlib.sha256(_DIGEST_DOMAIN + canonical_message(payload)).hexdigest()


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")  # noqa: TRY004 - uniform codec rejection
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{field} must not contain unpaired Unicode surrogates") from error
    return value


def _require_nonempty_string(value: Any, field: str) -> str:
    validated = _require_string(value, field)
    if validated == "":
        raise ValueError(f"{field} must be nonempty")
    return validated


def _require_nullable_string(value: Any, field: str) -> str | None:
    if value is None:
        return None
    return _require_string(value, field)
