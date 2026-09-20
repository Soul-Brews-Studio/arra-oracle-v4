"""Scratch-only creator for the publication-v1 reference dataset.

Builds a FRESH target-19 dataset under a temporary root and seeds the
reference rows a publication kernel needs to resolve its references: a
workspace, two peers, a session, three vocabularies, five terms, a message and
a trace. It writes no nodes and no revisions -- publishing those is the
kernel's job, and a fixture that pre-published them would be testing itself.

Three rules this module exists to keep:

1. The writer gate is acquired BEFORE ``lancedb.connect``, and held for the
   whole of creation and seeding. A lock taken after the dataset is open
   protects nothing, so the ordering here is the point, not an optimisation.
2. An existing target table is REFUSED, never replaced. There is no overwrite
   or reset mode, including on retry.
3. Every row is authored here. Nothing is copied from the target-v1 sample
   rows: a fixture that reuses the schema fixture's rows would make the two
   tests agree with each other rather than with the models.

Never imported by the migrator, never run against a live dataset, never calls
a model or the network.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import lancedb

from arra_migrate.target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from arra_migrate.writer_gate import writer_gate

__all__ = [
    "FIXTURE_VERSION",
    "FixtureRefusedError",
    "all_table_names",
    "create_publication_fixture",
]

FIXTURE_VERSION = "arra-publication-fixture/v1"

# nanoid(21) grammar, the same alphabet the service validates against.
_NANOID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

# One pinned instant for every seeded timestamp. A fixture whose contents
# change with the clock cannot be compared against itself across two runs.
# Built as UTC and then stripped: the physical columns are timestamp[us]
# WITHOUT a timezone, and the convention that the naive value IS UTC is what
# the round trip preserves. Constructing it naive in the first place would
# leave the intended zone unrecorded.
SEED_INSTANT = datetime(2026, 9, 20, 0, 0, 0, tzinfo=timezone.utc).replace(tzinfo=None)
SEED_EPOCH_MS = 1789862400000  # the same instant, for the legacy integer columns

# Legacy integer message ids start here and keep counting across workspaces:
# `messages.id` is a table-wide order, not a per-workspace one.
_FIRST_MESSAGE_ID = 1000

_RESERVED_TYPE = "type"
_RESERVED_HORIZON = "memory_horizon"
_TOPIC = "topic"

# (vocabulary name, label, kind, term_policy, cardinality, required, hierarchy)
#
# `type` and `memory_horizon` are the reserved vocabularies. `topic` is here so
# the kernel has a cardinality="many" and a term_policy="sealed" vocabulary to
# test against -- neither reserved one supplies either. Sealing governs term
# CREATION, not assignment: an existing active term in a sealed vocabulary is
# still assignable, and a test that reads it the other way is wrong.
_VOCABULARIES = (
    (_RESERVED_TYPE, "Node type", "categories", "open", "one", True, "flat"),
    (_RESERVED_HORIZON, "Memory horizon", "categories", "open", "one", False, "flat"),
    (_TOPIC, "Topic", "tags", "sealed", "many", False, "flat"),
)

# (vocabulary name, term name, is_active). Two ACTIVE type terms: exactly one
# may be assigned, so a second active one is what makes the cardinality rule
# refutable rather than vacuous.
_TERMS = (
    (_RESERVED_TYPE, "note", True),
    (_RESERVED_TYPE, "decision", True),
    (_RESERVED_HORIZON, "short_term", True),
    (_TOPIC, "storage", True),
    (_TOPIC, "retired_topic", False),
)


class FixtureRefusedError(RuntimeError):
    """The dataset already holds target tables. It is never replaced."""

    code = "fixture_refused"


def all_table_names(db) -> list[str]:
    """Every table in the dataset, not the first page of them.

    Two traps live here, both measured on lancedb 0.39.0. ``table_names`` is
    deprecated AND defaults to ``limit=10``, so a nineteen-table dataset
    reports ten and an existence check written on that default would
    cheerfully overwrite table eleven. ``list_tables`` is the current call and
    pages explicitly; the loop below follows ``page_token`` to exhaustion
    rather than trusting one response to be complete.
    """
    names: list[str] = []
    page_token = None
    while True:
        response = db.list_tables(page_token=page_token)
        names.extend(response.tables)
        page_token = response.page_token
        if not page_token:
            return names


def scoped_id(workspace: str, kind: str, name: str) -> str:
    """A deterministic nanoid21, distinct per (workspace, kind, name).

    Deterministic so two runs produce the same dataset, and workspace-scoped so
    no id is ever shared between two workspaces -- which is exactly the
    cross-workspace leak the kernel's reference tests need to be able to catch.
    """
    material = f"{FIXTURE_VERSION}\x1f{workspace}\x1f{kind}\x1f{name}"
    digest = hashlib.sha256(material.encode("utf-8")).digest()
    return "".join(_NANOID_ALPHABET[byte & 0x3F] for byte in digest[:21])


def _validate_workspaces(workspaces) -> list[str]:
    if not isinstance(workspaces, (list, tuple)):
        raise TypeError("workspaces must be a list of names")
    names = list(workspaces)
    if not names:
        raise ValueError("at least one workspace name is required")
    for name in names:
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"workspace name must be a non-blank string: {name!r}")
        if len(name.encode("utf-8")) > 256:
            raise ValueError(f"workspace name exceeds 256 UTF-8 bytes: {name!r}")
    if len(set(names)) != len(names):
        raise ValueError("workspace names must be distinct")
    return names


def _seed_workspace(workspace: str, message_id: int) -> tuple[dict, dict]:
    """Author one workspace's rows. Returns (rows by table, returned ids)."""
    models = TARGET_TABLES
    author = f"{workspace}-author"
    observer = f"{workspace}-observer"
    session = f"{workspace}-session-1"
    workspace_id = scoped_id(workspace, "workspace", workspace)
    message_public_id = scoped_id(workspace, "message", "message-1")
    trace_id = scoped_id(workspace, "trace", "trace-1")

    vocabulary_ids = {name: scoped_id(workspace, "vocabulary", name) for name, *_ in _VOCABULARIES}

    term_ids: dict[str, dict[str, dict]] = {name: {} for name in vocabulary_ids}
    term_rows = []
    for position, (vocabulary, term_name, is_active) in enumerate(_TERMS):
        term_id = scoped_id(workspace, "term", f"{vocabulary}/{term_name}")
        term_ids[vocabulary][term_name] = {
            "id": term_id,
            "name": term_name,
            "vocabulary_id": vocabulary_ids[vocabulary],
            "vocabulary_name": vocabulary,
            "is_active": is_active,
        }
        term_rows.append(
            models["terms"](
                id=term_id,
                workspace_name=workspace,
                vocabulary_id=vocabulary_ids[vocabulary],
                name=term_name,
                description=f"Seeded {vocabulary} term for publication fixtures.",
                parent_id=None,
                weight=float(position),
                is_active=is_active,
                h_metadata=None,
                created_at=SEED_INSTANT,
            )
        )

    rows = {
        "workspaces": [
            models["workspaces"](
                id=workspace_id,
                name=workspace,
                created_at=SEED_INSTANT,
                h_metadata=None,
                internal_metadata=None,
                configuration=None,
                mission="Publication fixture workspace. Not a live workspace.",
            )
        ],
        "peers": [
            models["peers"](
                id=scoped_id(workspace, "peer", role),
                name=peer_name,
                workspace_name=workspace,
                h_metadata=None,
                internal_metadata=None,
                configuration=None,
                created_at=SEED_INSTANT,
            )
            for role, peer_name in (("author", author), ("observer", observer))
        ],
        "sessions": [
            models["sessions"](
                id=scoped_id(workspace, "session", session),
                name=session,
                workspace_name=workspace,
                is_active=True,
                h_metadata=None,
                internal_metadata=None,
                configuration=None,
                created_at=SEED_INSTANT,
            )
        ],
        "session_peers": [
            models["session_peers"](
                workspace_name=workspace,
                session_name=session,
                peer_name=peer_name,
                configuration=None,
                internal_metadata=None,
                joined_at=SEED_INSTANT,
                left_at=None,
            )
            for peer_name in (author, observer)
        ],
        "messages": [
            models["messages"](
                id=message_id,
                public_id=message_public_id,
                workspace_name=workspace,
                session_name=session,
                peer_name=author,
                content=f"Seeded message for {workspace}. Authored by the fixture, not captured.",
                token_count=12,
                seq_in_session=1,
                h_metadata=None,
                internal_metadata=None,
                created_at=SEED_INSTANT,
                role="user",
                in_reply_to=None,
                read=None,
                read_at=None,
                # Locally authored: the source-identity triple is all-or-none
                # and this message has no external source, so all three stay null.
                source_namespace=None,
                source_message_id=None,
                source_payload_digest=None,
                source_created_at=None,
                ingested_at=SEED_INSTANT,
            )
        ],
        "vocabularies": [
            models["vocabularies"](
                id=vocabulary_ids[name],
                name=name,
                workspace_name=workspace,
                label=label,
                description=f"Seeded {kind} vocabulary for publication fixtures.",
                kind=kind,
                term_policy=term_policy,
                cardinality=cardinality,
                required=required,
                hierarchy=hierarchy,
                h_metadata=None,
                internal_metadata=None,
                created_at=SEED_INSTANT,
            )
            for name, label, kind, term_policy, cardinality, required, hierarchy in _VOCABULARIES
        ],
        "terms": term_rows,
        "traces": [
            models["traces"](
                id=trace_id,
                name=f"{workspace}-trace-1",
                workspace_name=workspace,
                session_name=session,
                peer_name=author,
                query="seeded fixture query",
                mode=None,
                session_id=None,
                session_from_ts=None,
                session_to_ts=None,
                friction_score=None,
                confidence=None,
                parent_id=None,
                prev_id=None,
                depth=0,
                status="raw",
                h_metadata=None,
                internal_metadata=None,
                created_at=SEED_EPOCH_MS,
                updated_at=SEED_EPOCH_MS,
            )
        ],
    }

    ids = {
        "workspace_id": workspace_id,
        "peer_names": [author, observer],
        "session_name": session,
        "vocabulary_ids": vocabulary_ids,
        "term_ids": term_ids,
        "message_public_id": message_public_id,
        "trace_id": trace_id,
    }
    return rows, ids


def create_publication_fixture(dataset_root: str, *, workspaces: list[str]) -> dict:
    """Create the nineteen target tables under *dataset_root* and seed them.

    Returns ``{workspace_name: {...ids...}}``; see the module docstring of the
    accompanying test for the exact shape. Raises ``WriterUnavailableError`` if
    another live owner holds the gate -- before the dataset is opened -- and
    ``FixtureRefusedError`` if any target table already exists.
    """
    names = _validate_workspaces(workspaces)

    seeded = {}
    rows_by_table: dict[str, list] = {}
    for offset, workspace in enumerate(names):
        rows, ids = _seed_workspace(workspace, _FIRST_MESSAGE_ID + offset)
        seeded[workspace] = ids
        for table, table_rows in rows.items():
            rows_by_table.setdefault(table, []).extend(table_rows)

    # THE ORDERING THAT MATTERS: gate first, connect second, held throughout.
    with writer_gate(dataset_root):
        db = lancedb.connect(str(Path(dataset_root)))
        existing = sorted(set(all_table_names(db)) & set(TARGET_TABLE_NAMES))
        if existing:
            raise FixtureRefusedError(
                "dataset already holds target tables, refusing to replace: " + ", ".join(existing)
            )
        for name in TARGET_TABLE_NAMES:
            table = db.create_table(name, schema=TARGET_TABLES[name])
            if rows_by_table.get(name):
                table.add(rows_by_table[name])

    return seeded


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    target = root / "publication-v1-lancedb"
    # No overwrite/reset mode, including on retry.
    target.mkdir(exist_ok=False)
    workspaces = sys.argv[2:] or ["alpha-workspace", "beta-workspace"]
    ids = create_publication_fixture(str(target), workspaces=workspaces)
    print(json.dumps({
        "fixture_version": FIXTURE_VERSION,
        "dataset_root": str(target),
        "tables": list(TARGET_TABLE_NAMES),
        "workspaces": ids,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
