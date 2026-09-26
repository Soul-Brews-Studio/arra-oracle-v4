"""Independent Python-side checks of the finished candidate.

The TS worker already re-reads every row through the TS stored-row codecs and
walks every migrated head (``readback`` in the report). These checks are the
Python schema owner's own, over the persisted Arrow schemas:

  - the candidate holds EXACTLY the 19 target tables, no more, no fewer;
  - each persisted schema renders identically to its ``target_v1`` model;
  - every migrated memory's first revision carries the legacy title and body
    byte-for-byte (a content digest of the MEANING, not a count);
  - the taxonomy's CROSS-ROW invariants, which no per-row codec can see: a
    term's vocabulary exists in its workspace; a term in a non-tree vocabulary
    has NO parent (the kernel reads one as ``integrity_failure`` and no API can
    repair it); a tree parent is a term of the same vocabulary; names fit the
    kernel's 256-byte bound.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import lancedb

from ..target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from ..target_v1.schema import describe_schema, diff_described
from .taxonomy_tables import name_too_long


def candidate_schema_problems(candidate_root: Path) -> list[str]:
    db = lancedb.connect(str(candidate_root))
    present = set(db.table_names(limit=1000))
    problems = [f"missing table {name!r}" for name in TARGET_TABLE_NAMES if name not in present]
    problems += [f"unexpected table {name!r}" for name in sorted(present - set(TARGET_TABLE_NAMES))]
    for name in TARGET_TABLE_NAMES:
        if name not in present:
            continue
        expected = describe_schema(TARGET_TABLES[name].to_arrow_schema())
        problems += [f"{name}: {p}" for p in diff_described(expected, describe_schema(db.open_table(name).schema))]
    return problems


def body_mismatches(candidate_root: Path, plan: dict[str, Any], migrated: set[str]) -> list[str]:
    revisions = {
        row["id"]: row
        for row in lancedb.connect(str(candidate_root)).open_table("node_revisions").to_arrow().to_pylist()
    }
    problems = []
    for workspace in plan["workspaces"]:
        for item in workspace["memories"]:
            if item["legacy_id"] not in migrated:
                continue
            row = revisions.get(item["revision_id"])
            if row is None:
                problems.append(f"{item['legacy_id']}: first revision {item['revision_id']} absent")
            elif (row["title"], row["body"]) != (item["title"], item["body"]):
                problems.append(f"{item['legacy_id']}: title/body differ from the legacy row")
    return problems


def taxonomy_problems(candidate_root: Path) -> list[str]:
    db = lancedb.connect(str(candidate_root))
    vocabularies = {(v["workspace_name"], v["id"]): v for v in db.open_table("vocabularies").to_arrow().to_pylist()}
    terms = {(t["workspace_name"], t["id"]): t for t in db.open_table("terms").to_arrow().to_pylist()}
    problems = [f"vocabulary {ws}/{vid}: name exceeds 256 UTF-8 bytes"
                for (ws, vid), v in sorted(vocabularies.items()) if name_too_long(v["name"])]
    for (ws, tid), term in sorted(terms.items()):
        vocabulary = vocabularies.get((ws, term["vocabulary_id"]))
        if name_too_long(term["name"]):
            problems.append(f"term {ws}/{tid}: name exceeds 256 UTF-8 bytes")
        if vocabulary is None:
            problems.append(f"term {ws}/{tid}: vocabulary {term['vocabulary_id']!r} absent from its workspace")
        elif term["parent_id"] is not None and vocabulary["hierarchy"] != "tree":
            problems.append(f"term {ws}/{tid}: parent {term['parent_id']!r} stored in "
                            f"{vocabulary['hierarchy']} vocabulary {vocabulary['name']!r}")
        elif term["parent_id"] is not None:
            parent = terms.get((ws, term["parent_id"]))
            if parent is None or parent["vocabulary_id"] != term["vocabulary_id"]:
                problems.append(f"term {ws}/{tid}: parent {term['parent_id']!r} is not a term of its vocabulary")
    return problems
