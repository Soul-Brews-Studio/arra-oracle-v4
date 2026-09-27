"""Scratch-only creator for the taxonomy-v1 BARE reference dataset (#48).

Builds a FRESH target-19 dataset under an existing local root and seeds one
workspace row per requested name. Nothing else. No peers, no sessions, no
vocabularies, no terms.

The emptiness is the feature. The taxonomy kernel's own bootstrap creates the
reserved `type` and `memory_horizon` vocabularies and their seven terms, and
its interesting behaviour -- fresh seed, resumed partial seed, conflict on a
changed row -- is only observable from a dataset where none of that exists
yet. A fixture that pre-seeded taxonomy rows would be answering the questions
the kernel's tests are supposed to ask.

Three rules this module exists to keep:

1. Input is validated BEFORE the writer gate is taken, and the gate is taken
   BEFORE ``lancedb.connect`` and held for all of creation and seeding. A lock
   acquired after the dataset is open protects nothing, so the ordering is the
   point rather than an optimisation.
2. An existing target table is REFUSED, never replaced. There is no overwrite,
   reset or merge mode, including on a retry.
3. Every identity and timestamp is authored here and deterministic. Nothing is
   copied from another fixture: two fixtures sharing rows would make their
   tests agree with each other rather than with the models.

Never imported by the migrator, never run against a live dataset, never calls
a model or the network.

CLI:

    export_taxonomy_fixture.py ROOT WORKSPACE [WORKSPACE ...]

prints ONE JSON line: {workspace_name: {"workspace_id": ...}}.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone

import lancedb
from arra_migrate.target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from arra_migrate.writer_gate import writer_gate

__all__ = [
    "FIXTURE_VERSION",
    "SEED_INSTANT",
    "FixtureRefusedError",
    "all_table_names",
    "create_taxonomy_fixture",
    "workspace_id_for",
]

FIXTURE_VERSION = "arra-taxonomy-fixture/v1"

#: nanoid(21) grammar, the alphabet the kernel validates identifiers against.
_NANOID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

#: Longest workspace name the reviewed grammar admits, in UTF-8 bytes.
_MAX_WORKSPACE_BYTES = 256

#: One pinned instant for every seeded timestamp, distinct from any other
#: fixture's. Built as UTC and then stripped, because the physical column is
#: timestamp[us] WITHOUT a timezone and the convention that the naive value IS
#: UTC is what the round trip preserves; constructing it naive from the start
#: would leave the intended zone unrecorded. Whole seconds, so the stored
#: microseconds are millisecond-aligned and a kernel that refuses a remainder
#: has nothing to refuse here.
SEED_INSTANT = datetime(2026, 9, 21, 0, 0, 0, tzinfo=timezone.utc).replace(tzinfo=None)

_WORKSPACES = "workspaces"


class FixtureRefusedError(RuntimeError):
    """The dataset already holds target tables. It is never replaced."""

    code = "fixture_refused"


def all_table_names(db) -> list[str]:
    """Every table in the dataset, not the first page of them.

    ``table_names`` is deprecated AND defaults to ``limit=10``, so a
    nineteen-table dataset reports ten of them and an existence check written
    on that default would cheerfully create table eleven on top of an existing
    one. ``list_tables`` is the current call and pages explicitly; this follows
    ``page_token`` to exhaustion rather than trusting one response to be the
    whole answer.
    """
    names: list[str] = []
    page_token = None
    while True:
        response = db.list_tables(page_token=page_token)
        names.extend(response.tables)
        page_token = response.page_token
        if not page_token:
            return names


def workspace_id_for(workspace: str) -> str:
    """A deterministic nanoid21 derived from the workspace name alone.

    Deterministic so two runs of the same request produce the same dataset,
    and name-derived so a workspace keeps its identity whether it was created
    alone or alongside others -- a test that seeds one workspace and then
    compares it against another run must not be defeated by the request shape.
    """
    material = f"{FIXTURE_VERSION}\x1f{workspace}\x1fworkspace"
    digest = hashlib.sha256(material.encode("utf-8")).digest()
    return "".join(_NANOID_ALPHABET[byte & 0x3F] for byte in digest[:21])


def _validate_workspaces(workspaces) -> list[str]:
    """Check the whole request before anything is locked or opened.

    Raising here rather than after the gate keeps a malformed request
    reporting as a malformed request: a caller that received
    ``writer_unavailable`` for a call that was never valid would be told the
    wrong thing about its own input.
    """
    if isinstance(workspaces, str) or not isinstance(workspaces, (list, tuple)):
        raise TypeError("workspaces must be a list of names")
    names = list(workspaces)
    if not names:
        raise ValueError("at least one workspace name is required")
    for name in names:
        if not isinstance(name, str):
            raise TypeError(f"workspace name must be a string: {name!r}")
        if not name.strip():
            raise ValueError(f"workspace name must be a non-blank string: {name!r}")
        if len(name.encode("utf-8")) > _MAX_WORKSPACE_BYTES:
            raise ValueError(f"workspace name exceeds {_MAX_WORKSPACE_BYTES} UTF-8 bytes: {name!r}")
    if len(set(names)) != len(names):
        raise ValueError("workspace names must be distinct")
    return names


def create_taxonomy_fixture(dataset_root: str, *, workspaces: list[str]) -> dict:
    """Create the nineteen target tables under *dataset_root*, seeding only
    ``workspaces``.

    Returns ``{workspace_name: {"workspace_id": nanoid21}}``.

    Raises ``TypeError``/``ValueError`` for a malformed request,
    ``UnsupportedDatasetError`` for a root that is not an existing local
    directory, ``WriterUnavailableError`` if another live owner holds the gate
    -- before the dataset is opened -- and ``FixtureRefusedError`` if any
    target table already exists.
    """
    names = _validate_workspaces(workspaces)
    model = TARGET_TABLES[_WORKSPACES]
    seeded = {name: {"workspace_id": workspace_id_for(name)} for name in names}
    rows = [
        model(
            id=seeded[name]["workspace_id"],
            name=name,
            created_at=SEED_INSTANT,
            h_metadata=None,
            internal_metadata=None,
            configuration=None,
            mission=None,
        )
        for name in names
    ]

    # THE ORDERING THAT MATTERS: gate first, connect second, held throughout.
    with writer_gate(dataset_root):
        db = lancedb.connect(dataset_root)
        existing = sorted(set(all_table_names(db)) & set(TARGET_TABLE_NAMES))
        if existing:
            raise FixtureRefusedError(
                "dataset already holds target tables, refusing to replace: " + ", ".join(existing)
            )
        for table_name in TARGET_TABLE_NAMES:
            table = db.create_table(table_name, schema=TARGET_TABLES[table_name])
            if table_name == _WORKSPACES:
                table.add(rows)

    return seeded


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "usage: export_taxonomy_fixture.py ROOT WORKSPACE [WORKSPACE ...]",
            file=sys.stderr,
        )
        return 2
    root, names = sys.argv[1], sys.argv[2:]
    # One JSON line and nothing else on stdout: the TypeScript helper parses
    # this, and a second line would make it guess which one to read.
    print(json.dumps(create_taxonomy_fixture(root, workspaces=names)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
