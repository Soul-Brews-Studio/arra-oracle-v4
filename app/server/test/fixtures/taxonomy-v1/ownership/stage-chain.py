"""Stage a deep term chain in a disposable dataset, for the tree-bound case only.

SETUP, never an oracle. The 1024-row ancestry limit cannot be reached through the
kernel without 1024 writes, so the chain is appended directly here and the kernel
is exercised only for the single boundary decision the test is about.

Like every other writer in this slice, this acquires the writer gate BEFORE
opening a writable connection. It touches only the disposable copy it is given.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import lancedb

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "migrate-py" / "src"))

from arra_migrate.writer_gate import writer_gate

# One pinned instant: a fixture whose contents change with the clock cannot be
# compared against itself across two runs.
SEED_INSTANT = datetime(2026, 9, 21, 0, 0, 0, tzinfo=timezone.utc).replace(tzinfo=None)


def main() -> None:
    root, workspace, vocabulary_id, depth, mover_id = sys.argv[1:6]
    depth = int(depth)

    chain = [f"chain{index:015d}aaaaa"[:21] for index in range(depth)]
    terms = []
    for index, term_id in enumerate(chain):
        terms.append(
            {
                "id": term_id,
                "workspace_name": workspace,
                "vocabulary_id": vocabulary_id,
                "name": f"chain-{index}",
                "description": None,
                # Row 0 is the root; every later row hangs off its predecessor.
                "parent_id": None if index == 0 else chain[index - 1],
                "weight": 0.0,
                "is_active": True,
                "h_metadata": None,
                "created_at": SEED_INSTANT,
            }
        )
    # The term that the kernel will try to reparent onto the chain tip.
    terms.append(
        {
            "id": mover_id,
            "workspace_name": workspace,
            "vocabulary_id": vocabulary_id,
            "name": "mover",
            "description": None,
            "parent_id": None,
            "weight": 0.0,
            "is_active": True,
            "h_metadata": None,
            "created_at": SEED_INSTANT,
        }
    )

    vocabulary = {
        "id": vocabulary_id,
        "name": "ownership-tree",
        "workspace_name": workspace,
        "label": "Ownership tree",
        "description": None,
        "kind": "categories",
        "term_policy": "open",
        "cardinality": "many",
        "required": False,
        "hierarchy": "tree",
        "h_metadata": None,
        "internal_metadata": None,
        "created_at": SEED_INSTANT,
    }

    with writer_gate(root):
        db = lancedb.connect(root)
        db.open_table("vocabularies").add([vocabulary])
        db.open_table("terms").add(terms)

    print(json.dumps({"tip_id": chain[-1], "mover_id": mover_id, "depth": depth}))


if __name__ == "__main__":
    main()
