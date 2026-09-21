"""Create (or complete) a target19 dataset for LOCAL DEV use only.

Not part of the reviewed migration path -- `arra_migrate.target_v1` declares
the 19 candidate tables but nothing in the package wires them into a runnable
CLI yet (the active registry served by `just migrate run` is still the
15-table baseline). This script is the dev-stack's own stopgap: it creates
whichever of the 19 declared tables are missing at `dataset_root` (idempotent,
like `arra-migrate` itself) and, if the `workspaces` table has no row named
`default`, inserts one directly.

Why the workspace row is inserted here rather than through the server's own
API: `knowledge/registry.ts` (the `/api/knowledge/*` method table) has no
`createWorkspace` entry -- every context method up to `registerPeer` assumes
the workspace row already exists (`requireContextWorkspaceRow` fails
`invalid_reference` otherwise). Peers/sessions/messages ARE seeded through the
real HTTP API by `dev-stack.sh`, once the server is up; only this one
first-workspace-row gap goes through pyarrow directly.

Never touches `app/data` -- the caller passes an explicit dataset_root under
`app/.tmp/`.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone

import lancedb

from arra_migrate.target_v1 import TARGET_TABLES


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: create_target19_dataset.py <dataset_root>", file=sys.stderr)
        return 2
    dataset_root = sys.argv[1]

    db = lancedb.connect(dataset_root)
    existing = set(db.table_names(limit=1000))
    if len(existing) >= 1000:
        raise RuntimeError("table listing hit the page limit; raise it before trusting this")

    for name, model in TARGET_TABLES.items():
        if name in existing:
            print(f"ok      {name}")
            continue
        db.create_table(name, schema=model)
        print(f"created {name} @ {dataset_root}/{name}.lance")

    workspaces = db.open_table("workspaces")
    workspaces.checkout_latest()
    already = workspaces.count_rows("name = 'default'")
    if already:
        print("ok      workspaces row 'default'")
    else:
        workspaces.add(
            [
                {
                    "id": "ws_default_devseed",
                    "name": "default",
                    "created_at": datetime.now(timezone.utc).replace(tzinfo=None),
                    "h_metadata": None,
                    "internal_metadata": None,
                    "configuration": None,
                    "mission": "local dev seed",
                }
            ]
        )
        print("seeded  workspaces row 'default'")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
