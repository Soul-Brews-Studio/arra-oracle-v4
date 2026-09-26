"""Client-side pre-check of stock Honcho's own limits. Issue #8.

Every constant here is transcribed from ``plastic-labs/honcho`` at the pinned
commit (``pin.HONCHO_V3_2_0``), not guessed:

  - ``CONTENT_MAX_CHARS`` = ``settings.MAX_MESSAGE_SIZE`` (``src/config.py``:
    ``Field(default=25_000, gt=0)``), the ``max_length`` on
    ``MessageCreate.content`` (``src/schemas/api.py``).
  - ``METADATA_MAX_KEYS`` / ``METADATA_MAX_DEPTH`` = ``_METADATA_MAX_KEYS`` /
    ``_METADATA_MAX_DEPTH`` (``src/schemas/api.py``), and ``_check_metadata`` below
    is a direct port of that module's ``_check_metadata_limits``: depth counts
    from 1 and only descends into ``dict`` values (a list of dicts is NOT
    walked -- that is Honcho's own behaviour, reproduced here on purpose, not
    a shortcut), and the key-count cap applies to the TOP level only.

A limit violation is refused here, before that message's own request body is
built, rather than discovered as a 422 after `bundle.py` has already sent
part of a session's messages -- see ``export_to_honcho``. This is scoped to
messages: the workspace/peers/sessions/session_peers ahead of them in
``export_to_honcho`` are still created first, so a message-level violation is
found only after those earlier resources already exist on the target.
"""

from __future__ import annotations

from typing import Any

CONTENT_MAX_CHARS = 25_000
METADATA_MAX_KEYS = 100
METADATA_MAX_DEPTH = 5

# MessageBatchCreate.messages: Field(..., min_length=1, max_length=100).
MESSAGE_BATCH_MAX = 100


class TierOneLimitError(ValueError):
    """A v4 row exceeds a stock-Honcho limit measured from the pinned schema."""


def check_content_limit(content: str, *, where: str = "messages.content") -> None:
    if len(content) > CONTENT_MAX_CHARS:
        raise TierOneLimitError(f"{where}: {len(content)} chars exceeds Honcho's {CONTENT_MAX_CHARS}-char cap")


def check_metadata_limits(metadata: dict[str, Any], *, where: str) -> None:
    _check_metadata(metadata, depth=1, where=where)


def _check_metadata(data: dict[str, Any], *, depth: int, where: str) -> None:
    if depth > METADATA_MAX_DEPTH:
        raise TierOneLimitError(f"{where}: metadata nesting exceeds Honcho's depth limit of {METADATA_MAX_DEPTH}")
    if depth == 1 and len(data) > METADATA_MAX_KEYS:
        raise TierOneLimitError(f"{where}: {len(data)} top-level keys exceeds Honcho's {METADATA_MAX_KEYS}-key cap")
    for value in data.values():
        if isinstance(value, dict):
            _check_metadata(value, depth=depth + 1, where=where)
