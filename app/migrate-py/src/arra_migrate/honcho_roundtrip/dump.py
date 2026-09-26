"""Tier-1 dump: a real v4 dataset -> ``Tier1Bundle``. Issue #8, ruling R15.

Two things live here, deliberately together:

  ``dump_tier1``           reads an existing dataset. Never writes.
  ``build_spec_15_5_bank``  writes the SPEC §15.5 fixture into a fresh,
                            disposable dataset (the ONLY writer in this
                            module), so a round-trip test has one real bank to
                            dump, export, import, export and diff -- not a
                            hand-written dict standing in for one.

Before this module, issue #8's only "export" was a dict literal in the test
file (``.tmp/understand/issue-8/repro_output.txt`` root cause 1). That
fixture's names, ids and timestamps did not resemble real v4 rows closely
enough to exercise the name-pattern or timestamp-serialization defects this
issue is about.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import lancedb

from ..models import TABLES as ACTIVE_TABLES
from .bundle import Tier1Bundle

# ---------------------------------------------------------------------------
# Read: dump_tier1
# ---------------------------------------------------------------------------


class _ReadOnlySource:
    """Same enforcement as ``arra_migrate.rehearsal._ReadOnlySource``, kept as
    its own small copy rather than an import of a leading-underscore name from
    another module: ``dump_tier1`` must never be able to mutate the dataset it
    is asked to read, and that guarantee should not depend on a private
    contract elsewhere staying exactly as it is today."""

    _FORBIDDEN = ("create_table", "drop_table", "drop_all_tables", "drop_database", "rename_table")

    def __init__(self, db: Any) -> None:
        self._db = db

    def __getattr__(self, name: str) -> Any:
        if name in self._FORBIDDEN:
            raise RuntimeError(f"dump_tier1 attempted a mutating source call: {name}()")
        return getattr(self._db, name)


def _utc_aware(row: dict[str, Any]) -> dict[str, Any]:
    """A `timestamp[us]` column round-trips through pyarrow's `to_pylist` as a
    NAIVE `datetime` (LanceDB never writes an Arrow tz). v4's own convention is
    that naive means UTC (see `rehearsal.py`'s `T0` comment) -- this makes that
    convention explicit and load-bearing rather than implicit, because the
    Honcho leg needs a real UTC instant to encode (`wire.to_wire_timestamp`
    assumes exactly this)."""

    out = dict(row)
    for key, value in out.items():
        if isinstance(value, datetime) and value.tzinfo is None:
            out[key] = value.replace(tzinfo=timezone.utc)
    return out


def _read_table(source: Any, table_name: str, workspace_name: str, *, name_field: str = "workspace_name") -> list[dict[str, Any]]:
    try:
        handle = source.open_table(table_name)
    except FileNotFoundError:
        return []
    rows = handle.to_arrow().to_pylist()
    return [_utc_aware(r) for r in rows if r.get(name_field) == workspace_name]


def dump_tier1(root: Path, workspace_name: str) -> Tier1Bundle:
    """Read-only dump of one workspace's tier-1 rows from a real dataset at
    *root*.

    - Filtered to *workspace_name* only (``workspaces.name`` for the workspace
      row itself; ``workspace_name`` for every dependent table).
    - Messages come back sorted by ``seq_in_session`` within each session --
      the ordering `verify_round_trip`'s predecessor never checked
      (``.tmp/understand/issue-8/repro_output.txt`` finding D).
    - Every ``datetime`` value is UTC-aware on the way out (see `_utc_aware`).
    - Schema-tolerant on purpose: a target-19 dataset's `messages` table
      carries five extra columns (`source_namespace`, `source_message_id`,
      `source_payload_digest`, `source_created_at`, `ingested_at`) that an
      active-15 dataset does not. `to_pylist` already returns exactly whatever
      columns the table has -- this function does not enumerate columns by
      name anywhere, so both shapes come back as-is with no branch needed.
    """

    db = lancedb.connect(str(root))
    source = _ReadOnlySource(db)

    all_workspaces = _read_table(source, "workspaces", workspace_name, name_field="name")
    if not all_workspaces:
        raise ValueError(f"workspace {workspace_name!r} not found under {root}")

    peers = _read_table(source, "peers", workspace_name)
    sessions = _read_table(source, "sessions", workspace_name)
    session_peers = _read_table(source, "session_peers", workspace_name)
    messages = _read_table(source, "messages", workspace_name)
    messages.sort(key=lambda m: (m["session_name"], m["seq_in_session"]))

    return Tier1Bundle(
        workspaces=all_workspaces,
        peers=peers,
        sessions=sessions,
        session_peers=session_peers,
        messages=messages,
    )


# ---------------------------------------------------------------------------
# Write: build_spec_15_5_bank
# ---------------------------------------------------------------------------

# SPEC.md §15.5's own numbers: "2 rooms [sessions], 3 entities [peers], 10
# messages". T0 is deliberately NOT ms-aligned to a round second so a
# regression that truncates precision (issue #105's actual bug, in the
# opposite direction) would show up as a changed value, not a coincidence.
T0 = datetime(2026, 9, 26, 21, 0, 0, 250000, tzinfo=timezone.utc)

WORKSPACE_NAME = "ws-spec-15-5"

# The federation name: the whole point is that it is NOT
# `^[a-zA-Z0-9_-]+$` -- it has a `:` -- so a round trip that skips
# `names.honcho_name` fails loudly against `FakeHonchoTarget` rather than
# silently mangling it.
FEDERATION_PEER_NAME = "m5:arra-oracle-v3"


def _bank_rows() -> dict[str, list[dict[str, Any]]]:
    return {
        "workspaces": [
            {
                "id": "ws-01", "name": WORKSPACE_NAME, "created_at": T0,
                "h_metadata": '{"kind": "test"}', "internal_metadata": '{"secret": "not-for-honcho"}',
                "configuration": '{"peer_card": {"max_tokens": 500}}', "mission": "SPEC §15.5 round-trip bank",
            },
        ],
        "peers": [
            {"id": "peer-01", "name": "nat", "workspace_name": WORKSPACE_NAME,
             "h_metadata": '{"display_name": "Nat"}', "internal_metadata": '{"internal": true}',
             "configuration": '{"observe_me": true}', "created_at": T0},
            {"id": "peer-02", "name": "neo", "workspace_name": WORKSPACE_NAME,
             "h_metadata": None, "internal_metadata": None, "configuration": None,
             "created_at": T0 + timedelta(seconds=1)},
            # The federation-tagged peer: exercises the reversible name encoding.
            {"id": "peer-03", "name": FEDERATION_PEER_NAME, "workspace_name": WORKSPACE_NAME,
             "h_metadata": '{"kind": "oracle", "repo_url": "https://github.com/Soul-Brews-Studio/arra-oracle-v3"}',
             "internal_metadata": None, "configuration": None, "created_at": T0 + timedelta(seconds=2)},
        ],
        "sessions": [
            {"id": "sess-01", "name": "session-one", "workspace_name": WORKSPACE_NAME,
             "is_active": True, "h_metadata": '{"room": "general"}', "internal_metadata": None,
             "configuration": None, "created_at": T0 + timedelta(seconds=3)},
            {"id": "sess-02", "name": "session-two", "workspace_name": WORKSPACE_NAME,
             "is_active": True, "h_metadata": None, "internal_metadata": '{"do_not_forward": true}',
             "configuration": None, "created_at": T0 + timedelta(seconds=4)},
        ],
        "session_peers": [
            {"workspace_name": WORKSPACE_NAME, "session_name": "session-one", "peer_name": "nat",
             "configuration": '{"pinned": true}', "internal_metadata": '{"joined_via": "test"}',
             "joined_at": T0 + timedelta(seconds=5), "left_at": None},
            # neo: joins session-one, then LEAVES it -- the departed peer.
            {"workspace_name": WORKSPACE_NAME, "session_name": "session-one", "peer_name": "neo",
             "configuration": None, "internal_metadata": None,
             "joined_at": T0 + timedelta(seconds=6), "left_at": T0 + timedelta(hours=1)},
            {"workspace_name": WORKSPACE_NAME, "session_name": "session-one", "peer_name": FEDERATION_PEER_NAME,
             "configuration": None, "internal_metadata": None,
             "joined_at": T0 + timedelta(seconds=7), "left_at": None},
            {"workspace_name": WORKSPACE_NAME, "session_name": "session-two", "peer_name": "nat",
             "configuration": None, "internal_metadata": None,
             "joined_at": T0 + timedelta(seconds=8), "left_at": None},
            {"workspace_name": WORKSPACE_NAME, "session_name": "session-two", "peer_name": FEDERATION_PEER_NAME,
             "configuration": None, "internal_metadata": None,
             "joined_at": T0 + timedelta(seconds=9), "left_at": None},
        ],
        "messages": [
            {"id": 1, "public_id": "msg-pub-01", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-one", "peer_name": "nat", "content": "let's start the round trip",
             "token_count": 5, "seq_in_session": 1, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(seconds=10), "role": "question", "in_reply_to": None,
             "read": None, "read_at": None},
            {"id": 2, "public_id": "msg-pub-02", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-one", "peer_name": "neo", "content": "ภาษาไทย 🌱 ทดสอบการ round trip",
             "token_count": 3, "seq_in_session": 2, "h_metadata": '{"note": "kept"}', "internal_metadata": None,
             "created_at": T0 + timedelta(seconds=11), "role": "answer", "in_reply_to": "msg-pub-01",
             "read": True, "read_at": T0 + timedelta(seconds=12)},
            {"id": 3, "public_id": "msg-pub-03", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-one", "peer_name": FEDERATION_PEER_NAME, "content": "observing from m5",
             "token_count": 3, "seq_in_session": 3, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(seconds=13), "role": "note", "in_reply_to": None,
             "read": None, "read_at": None},
            {"id": 4, "public_id": "msg-pub-04", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-one", "peer_name": "nat", "content": "one more before neo leaves",
             "token_count": 5, "seq_in_session": 4, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(seconds=14), "role": None, "in_reply_to": None,
             "read": None, "read_at": None},
            {"id": 5, "public_id": "msg-pub-05", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-one", "peer_name": "nat", "content": "neo has left by now",
             "token_count": 4, "seq_in_session": 5, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(hours=1, seconds=1), "role": None, "in_reply_to": None,
             "read": None, "read_at": None},
            {"id": 6, "public_id": "msg-pub-06", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-one", "peer_name": FEDERATION_PEER_NAME, "content": "still here though",
             "token_count": 3, "seq_in_session": 6, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(hours=1, seconds=2), "role": None, "in_reply_to": None,
             "read": None, "read_at": None},
            {"id": 7, "public_id": "msg-pub-07", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-two", "peer_name": "nat", "content": "second session starts",
             "token_count": 3, "seq_in_session": 1, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(seconds=15), "role": "question", "in_reply_to": None,
             "read": None, "read_at": None},
            {"id": 8, "public_id": "msg-pub-08", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-two", "peer_name": FEDERATION_PEER_NAME, "content": "acknowledged",
             "token_count": 1, "seq_in_session": 2, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(seconds=16), "role": "answer", "in_reply_to": "msg-pub-07",
             "read": True, "read_at": T0 + timedelta(seconds=17)},
            {"id": 9, "public_id": "msg-pub-09", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-two", "peer_name": "nat", "content": "closing thought",
             "token_count": 2, "seq_in_session": 3, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(seconds=18), "role": None, "in_reply_to": None,
             "read": None, "read_at": None},
            {"id": 10, "public_id": "msg-pub-10", "workspace_name": WORKSPACE_NAME,
             "session_name": "session-two", "peer_name": FEDERATION_PEER_NAME, "content": "จบ session",
             "token_count": 1, "seq_in_session": 4, "h_metadata": None, "internal_metadata": None,
             "created_at": T0 + timedelta(seconds=19), "role": None, "in_reply_to": None,
             "read": None, "read_at": None},
        ],
    }


def build_spec_15_5_bank(root: Path) -> Tier1Bundle:
    """Write the SPEC §15.5 bank (2 sessions, 3 peers, 10 messages, a
    federation name, Thai text, one departed peer) into a fresh active-15
    dataset at *root*, and return it as the same `Tier1Bundle` shape
    `dump_tier1` would read back. *root* must not already contain a dataset --
    callers pass a fresh `tempfile.mkdtemp()`, matching every other fixture in
    this repo (`rehearsal.build_source`, `publication-fixture.ts`); this
    module never reuses or cleans up a directory.
    """

    db = lancedb.connect(str(root))
    rows = _bank_rows()
    for name, model in ACTIVE_TABLES.items():
        if name not in rows:
            continue
        table = db.create_table(name, schema=model)
        table.add([model(**row) for row in rows[name]])

    return Tier1Bundle(
        workspaces=rows["workspaces"],
        peers=rows["peers"],
        sessions=rows["sessions"],
        session_peers=rows["session_peers"],
        messages=rows["messages"],
    )
