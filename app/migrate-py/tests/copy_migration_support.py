"""Shared helpers for the #34 copy-migration tests (no TestCase in here).

Kept out of the test modules so both can import them without unittest
collecting one module's cases twice.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import lancedb

INTAKE_AT = "2026-09-26T14:00:00.000Z"


def tree(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def run(parent: Path, name: str, **kwargs):
    from arra_migrate.copy_migration import run_copy_migration

    candidate = parent / f"{name}-candidate"
    work = parent / f"{name}-work"
    candidate.mkdir()
    report = run_copy_migration(parent / "source", candidate, work, intake_at=INTAKE_AT, **kwargs)
    return report, candidate, work


def rows(root: Path, table: str) -> list[dict]:
    return lancedb.connect(str(root)).open_table(table).to_arrow().to_pylist()


def records(work: Path) -> list[dict]:
    return [json.loads(line) for line in (work / "records.jsonl").read_text().splitlines()]


def legacy_node_id(ws: str, legacy_id: str) -> str:
    """R18 D1, written out independently of the implementation."""

    digest = hashlib.sha256(f"arra-legacy-node/v1\n{ws}\n{legacy_id}".encode()).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii")[:21]
