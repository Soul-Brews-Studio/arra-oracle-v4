"""Create the tables declared in models.py. Idempotent; never reads them back.

    uv run arra-migrate              # create what is missing, leave the rest alone
    ARRA_RESET=1 uv run arra-migrate # recreate (old versions stay -- Lance deletes nothing)
    uv run arra-migrate --check      # exit 1 if disk disagrees with models.py
"""

import os
import sys

import lancedb

from .models import TABLES

DATA_DIR = os.environ.get("ARRA_DATA_DIR", "../data")


def _print_schema(tbl) -> None:
    for f in tbl.schema:
        null = "" if not f.nullable else "  null"
        print(f"  {f.name:<20} {f.type}{null}")


def main() -> int:
    check_only = "--check" in sys.argv
    reset = bool(os.environ.get("ARRA_RESET"))

    db = lancedb.connect(DATA_DIR)

    # `table_names()` PAGINATES, defaulting to 10. With 15 tables the tail came
    # back missing, so the "already exists" check below said absent and the
    # overwrite would have destroyed tables 11-15 on every re-run. Ask for more
    # than can exist, and assert we did not hit the ceiling anyway.
    existing = set(db.table_names(limit=1000))
    if len(existing) >= 1000:
        raise RuntimeError("table listing hit the page limit; raise it before trusting this")

    drift = 0

    for name, model in TABLES.items():
        if name in existing and not reset:
            tbl = db.open_table(name)

            # models.py is the source of truth; disk is the thing that can be stale.
            # Compare TYPE as well as name: on 2026-09-18 this said `ok` while the
            # disk held Vector(1024) and the model declared Vector(384). A name-only
            # diff cannot see a dimension change, which is the most likely drift.
            declared = {f.name: (str(f.type), f.nullable) for f in model.to_arrow_schema()}
            on_disk = {f.name: (str(f.type), f.nullable) for f in tbl.schema}
            missing = sorted(declared.keys() - on_disk.keys())
            extra = sorted(on_disk.keys() - declared.keys())
            retyped = sorted(
                f"{k}: disk={on_disk[k][0]} declared={declared[k][0]}"
                for k in declared.keys() & on_disk.keys()
                if declared[k] != on_disk[k]
            )
            if missing or extra or retyped:
                drift += 1
                print(f"DRIFT {name}: missing={missing} extra={extra}")
                for r in retyped:
                    print(f"      {r}")
            else:
                print(f"ok    {name} -- rows={tbl.count_rows()} version={tbl.version}")
            continue

        if check_only:
            drift += 1
            print(f"MISSING {name}: declared in models.py, absent on disk")
            continue

        tbl = db.create_table(name, schema=model, mode="overwrite")
        print(f"created {name} @ {DATA_DIR}/{name}.lance")
        _print_schema(tbl)

    if check_only and drift:
        print(f"\n{drift} table(s) disagree with models.py", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
