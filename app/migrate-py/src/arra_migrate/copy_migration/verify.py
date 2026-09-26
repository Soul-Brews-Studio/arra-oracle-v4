"""Independent Python-side checks of the finished candidate.

The TS worker already re-reads every row through the TS stored-row codecs and
walks every migrated head (``readback`` in the report). These checks are the
Python schema owner's own, over the persisted Arrow schemas:

  - the candidate holds EXACTLY the 19 target tables, no more, no fewer;
  - each persisted schema renders identically to its ``target_v1`` model;
  - every migrated memory's first revision carries the legacy title and body
    byte-for-byte (a content digest of the MEANING, not a count).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import lancedb

from ..target_v1 import TARGET_TABLE_NAMES, TARGET_TABLES
from ..target_v1.schema import describe_schema, diff_described


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
