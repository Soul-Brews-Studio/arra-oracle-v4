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

R1 (overnight rulings, 2026-09-26, #105/#75): `workspaces.created_at` is
physical `timestamp[us]`, and `read-cursor.ts`'s `validateWorkspaceRow`
correctly fails closed on a non-zero microsecond remainder
(context-ingestion-v1.md:57, read-cursor-v1.md:30). `datetime.now()` carries
genuine microsecond precision, so seeding it directly broke `getReadCursor`
and `advanceReadCursor` on almost every fresh dev dataset. This script now
truncates to the millisecond before writing, and refuses -- rather than
silently blessing with "ok" -- an EXISTING `default` row that still has a
sub-millisecond remainder, since repairing data in place has no ruling behind
it. See docs/overnight/DECISIONS.md R1/R2.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone

import lancedb

from arra_migrate.target_v1 import TARGET_TABLES

MICROS_PER_MILLI = 1000


def _truncate_to_millisecond(instant: datetime) -> datetime:
    """Truncate (never round) to the millisecond every reader in this project
    treats as the physical unit floor for a `timestamp[us]` column."""
    return instant.replace(microsecond=instant.microsecond - instant.microsecond % MICROS_PER_MILLI)


def main(argv: list[str] | None = None, now: datetime | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: create_target19_dataset.py <dataset_root>", file=sys.stderr)
        return 2
    dataset_root = argv[0]

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
    rows = [r for r in workspaces.to_arrow().to_pylist() if r["name"] == "default"]
    if rows:
        remainder = rows[0]["created_at"].microsecond % MICROS_PER_MILLI
        if remainder != 0:
            print(
                f"refused workspaces row 'default': created_at has a {remainder}µs "
                "sub-millisecond remainder, which every context kernel that "
                "validates a workspace row fails closed on (#75). This dataset "
                "predates the R1 fix. Regenerate it -- remove this dataset_root "
                "and rerun -- rather than seeding on top of it; this script "
                "never repairs existing rows in place.",
                file=sys.stderr,
            )
            return 1
        print("ok      workspaces row 'default'")
    else:
        instant = _truncate_to_millisecond(now or datetime.now(timezone.utc)).replace(tzinfo=None)
        workspaces.add(
            [
                {
                    "id": "ws_default_devseed",
                    "name": "default",
                    "created_at": instant,
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
