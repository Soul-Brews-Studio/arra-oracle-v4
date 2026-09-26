"""Deterministic legacy-id -> nanoid21 mapping. The ONE id authority of the copy.

The target codecs demand the nanoid21 grammar for peer, session, message
public, term, vocabulary, trace, node and revision identifiers; legacy rows
carry ids like ``m_muigqmxf_qchtyc`` or ``msg-001``. Every such id goes through
``IdMap.assign``:

  - an id that ALREADY satisfies nanoid21 is kept unchanged (preserve IDs);
  - anything else becomes base64url(sha256(domain, kind, workspace, legacy))[:21],
    so a rerun into a fresh candidate yields identical ids with no RNG;
  - a second legacy id landing on the same target id raises ``IdCollision``,
    which the caller reports as a rejected record -- never a silent merge.

Workspace ids are NOT mapped: ``read-cursor.validateWorkspaceRow`` states they
are physical required strings with no nanoid decision, so they pass through.

Every assignment is written to ``id_map.jsonl`` in the work directory.
"""

from __future__ import annotations

import base64
import hashlib
import re
from typing import Any

NANOID21 = re.compile(r"^[A-Za-z0-9_-]{21}$")
DOMAIN = "arra-migrate-copy/v1"


class IdCollision(ValueError):
    """Two distinct legacy keys would share one target id."""


def is_nanoid21(value: object) -> bool:
    return isinstance(value, str) and NANOID21.fullmatch(value) is not None


def derive_nanoid21(kind: str, workspace: str, legacy_key: str) -> str:
    material = f"{DOMAIN}\n{kind}\n{workspace}\n{legacy_key}".encode()
    return base64.urlsafe_b64encode(hashlib.sha256(material).digest()).decode("ascii")[:21]


class IdMap:
    """(kind, workspace, legacy id) -> target id, with collision refusal."""

    def __init__(self) -> None:
        self._forward: dict[tuple[str, str, str], str] = {}
        self._claimed: dict[tuple[str, str], tuple[str, str]] = {}
        self._entries: list[dict[str, Any]] = []

    def assign(self, kind: str, workspace: str, legacy_id: str, *, derived_key: str | None = None) -> str:
        """Map one legacy id. ``derived_key`` names a SYNTHETIC id (no legacy
        id of that kind exists, e.g. a node's first revision); it is always
        derived, never kept."""

        key = (kind, workspace, legacy_id)
        if key in self._forward:
            return self._forward[key]
        if derived_key is None and is_nanoid21(legacy_id):
            target, basis = legacy_id, "kept"
        else:
            target, basis = derive_nanoid21(kind, workspace, derived_key or legacy_id), "derived"
        owner = self._claimed.get((kind, target))
        if owner is not None and owner != (workspace, legacy_id):
            raise IdCollision(f"{kind}: {legacy_id!r} and {owner[1]!r} both map to {target}")
        self._claimed[(kind, target)] = (workspace, legacy_id)
        self._forward[key] = target
        self._entries.append({
            "kind": kind, "workspace": workspace, "legacy_id": legacy_id,
            "target_id": target, "basis": basis,
        })
        return target

    def lookup(self, kind: str, workspace: str, legacy_id: str | None) -> str | None:
        if legacy_id is None:
            return None
        return self._forward.get((kind, workspace, legacy_id))

    def entries(self) -> list[dict[str, Any]]:
        return list(self._entries)
