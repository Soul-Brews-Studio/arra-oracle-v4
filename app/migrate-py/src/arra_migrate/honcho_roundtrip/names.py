"""Reversible name encoding for stock Honcho's resource-id charset. Issue #8.

Verified 2026-09-26 against ``plastic-labs/honcho`` at the pinned commit
(``pin.HONCHO_V3_2_0``), ``src/schemas/api.py``: ``WorkspaceCreate``,
``PeerCreate`` and ``SessionCreate`` all narrow their id field to
``Field(alias="id", min_length=1, max_length=512, pattern=RESOURCE_NAME_PATTERN)``
with ``RESOURCE_NAME_PATTERN = r"^[a-zA-Z0-9_-]+$"``. v4 names are unconstrained
(``policy.requireWorkspaceName.ts``) and documents federation-tagged peer names
like ``m5:arra-oracle-v3`` (``models/peer.py``) and Thai session/workspace
names -- every one of those is refused by a real Honcho 422 today (measured,
``.tmp/understand/issue-8/repro_output.txt`` finding F).

The encoding is ACE-style (the same idea IDNA/punycode uses for a hostname
label): a name that already satisfies the pattern AND does not start with the
reserved prefix is sent unchanged. Everything else -- an invalid charset, OR a
valid-charset name that merely *starts with* the reserved prefix -- is base64
encoded behind that prefix. That second clause is required for the encoding to
be a true bijection: without it, the legitimate name ``"hnb64-abc"`` and the
encoded form of some other string could not be told apart on the way back.
``urlsafe_b64encode`` is used deliberately -- its alphabet is exactly
``[A-Za-z0-9_-]`` (padding aside), so the encoded output always satisfies
``RESOURCE_NAME_PATTERN`` by construction, with no further escaping.
"""

from __future__ import annotations

import base64
import re

RESOURCE_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")

# schemas/api.py: WorkspaceCreate.name / PeerCreate.name / SessionCreate.name,
# all `Field(alias="id", min_length=1, max_length=512, pattern=...)`.
RESOURCE_NAME_MAX_LENGTH = 512

# Arbitrary but fixed marker, itself matching RESOURCE_NAME_PATTERN. Picked to
# be unlikely to collide with a real v4 name in practice; the anti-collision
# clause below is what makes correctness NOT depend on that being true.
ENCODED_NAME_PREFIX = "hnb64-"


class UnrepresentableNameError(ValueError):
    """A v4 name has no representation Honcho's resource-id charset accepts,
    even after encoding (over the 512-char limit once encoded)."""


def _is_wire_safe(name: str) -> bool:
    return (
        bool(RESOURCE_NAME_PATTERN.fullmatch(name))
        and not name.startswith(ENCODED_NAME_PREFIX)
        and len(name) <= RESOURCE_NAME_MAX_LENGTH
    )


def honcho_name(v4_name: str) -> str:
    """v4 name -> a name stock Honcho's ``RESOURCE_NAME_PATTERN`` accepts.

    Identity for a name that is already safe, not itself prefix-colliding, and
    within the 512-char limit. Otherwise ``ENCODED_NAME_PREFIX`` + unpadded
    urlsafe-base64 of the UTF-8 bytes. Raises if the encoded form still cannot
    fit in 512 chars -- silently truncating a name is worse than refusing it.
    """

    if _is_wire_safe(v4_name):
        return v4_name

    encoded = ENCODED_NAME_PREFIX + base64.urlsafe_b64encode(v4_name.encode("utf-8")).decode("ascii").rstrip("=")
    if len(encoded) > RESOURCE_NAME_MAX_LENGTH:
        raise UnrepresentableNameError(
            f"name {v4_name!r} encodes to {len(encoded)} chars, over Honcho's {RESOURCE_NAME_MAX_LENGTH}-char resource-id limit"
        )
    return encoded


def decode_honcho_name(wire_name: str) -> str:
    """The exact inverse of ``honcho_name``."""

    if not wire_name.startswith(ENCODED_NAME_PREFIX):
        return wire_name
    b64 = wire_name[len(ENCODED_NAME_PREFIX):]
    padded = b64 + "=" * (-len(b64) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
