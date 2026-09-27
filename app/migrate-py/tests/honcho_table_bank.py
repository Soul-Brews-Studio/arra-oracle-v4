"""The SPEC §15.5 bank, written as a TARGET-19 dataset for the table-level leg.

A TEST helper, not a package module: ``test_target_schema_v1``'s isolation
guard keeps every ``arra_migrate`` module except the candidate itself,
``copy_migration/`` and ``rehearsal.py`` from importing ``target_v1`` -- and
a fixture writer has no reason to ship in the production package.

Issue #8, ruling R15 (2026-09-27 table-level update). ``dump.build_spec_15_5_
bank`` writes the active-15 shape with readable ids (``ws-01``, ``msg-pub-01``)
-- fine for the REST leg, which never sends ids, but a table dump sends every
column, and stock Honcho's CHECK constraints reject any id that is not
nanoid21. v4's own contracts require nanoid21 for ``peers.id``,
``sessions.id`` and ``messages.public_id`` (context-ingestion-v1), so this
bank uses deterministic nanoid21 values there -- the shape a real v4 bank
has -- and fills the target-19 additions (``source_*``, ``ingested_at``) so
the dump carries every column the table-level diff has to account for.

Its workspace is ``TABLE_WORKSPACE_NAME``, not ``dump.WORKSPACE_NAME``: the
harness runs the REST leg against the same disposable database, and a second
``ws-spec-15-5`` row would collide on Honcho's UNIQUE (name).

Same rows otherwise: 2 sessions, 3 peers (one federation name with ``:``),
10 messages (Thai, emoji), one departed peer. One message adds a quote and a
backslash so SQL literal escaping is exercised against the real server.
"""

from __future__ import annotations

import base64
import hashlib
from datetime import timedelta
from pathlib import Path
from typing import Any

import lancedb

from arra_migrate.honcho_roundtrip.bundle import Tier1Bundle
from arra_migrate.honcho_roundtrip.dump import T0, WORKSPACE_NAME, _bank_rows
from arra_migrate.target_v1 import core as target19

TABLE_WORKSPACE_NAME = "ws-spec-15-5-table"

_MODELS = {
    "workspaces": target19.Workspace,
    "peers": target19.Peer,
    "sessions": target19.Session,
    "session_peers": target19.SessionPeer,
    "messages": target19.Message,
}


def nanoid21_for(seed: str) -> str:
    """Deterministic 21-char id in nanoid's alphabet ``[A-Za-z0-9_-]``."""

    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii")[:21]


def _target19_rows(workspace_name: str, id_seed: str) -> dict[str, list[dict[str, Any]]]:
    rows = _bank_rows()
    rows["workspaces"][0]["name"] = workspace_name
    for table in ("peers", "sessions", "session_peers", "messages"):
        for r in rows[table]:
            if r["workspace_name"] == WORKSPACE_NAME:
                r["workspace_name"] = workspace_name
    public = {m["public_id"]: nanoid21_for(id_seed + m["public_id"]) for m in rows["messages"]}
    for table in ("workspaces", "peers", "sessions"):
        for r in rows[table]:
            r["id"] = nanoid21_for(id_seed + r["id"])
    for m in rows["messages"]:
        m["public_id"] = public[m["public_id"]]
        m["in_reply_to"] = public.get(m["in_reply_to"]) if m["in_reply_to"] else None
        m["ingested_at"] = T0 + timedelta(hours=2, milliseconds=m["id"])
        m.update(source_namespace=None, source_message_id=None, source_payload_digest=None, source_created_at=None)
        if m["session_name"] == "session-two" and m["id"] in (7, 8):
            m.update(
                source_namespace="relic",
                source_message_id=f"relic-{m['id']:05d}",
                source_payload_digest=hashlib.sha256(m["content"].encode("utf-8")).hexdigest(),
                source_created_at=m["created_at"] - timedelta(minutes=5),
            )
        if m["id"] == 4:
            m["content"] = "one more before neo leaves -- it's a 'quoted' C:\\path"
    return rows


def build_target19_bank(root: Path, workspace_name: str = TABLE_WORKSPACE_NAME, id_seed: str = "") -> Tier1Bundle:
    """Write the bank into a fresh target-19 dataset at *root* (a caller's
    ``tempfile.mkdtemp()``) and return the rows as written. A different
    *workspace_name* and *id_seed* give a second, independent bank -- another
    v4 dataset -- whose text ids differ but whose integer ``messages.id``
    values (1..10, v4's per-dataset legacy order) are the same."""

    db = lancedb.connect(str(root))
    rows = _target19_rows(workspace_name, id_seed)
    for name, model in _MODELS.items():
        table = db.create_table(name, schema=model)
        table.add([model(**row) for row in rows[name]])
    return Tier1Bundle(
        workspaces=rows["workspaces"],
        peers=rows["peers"],
        sessions=rows["sessions"],
        session_peers=rows["session_peers"],
        messages=rows["messages"],
    )
