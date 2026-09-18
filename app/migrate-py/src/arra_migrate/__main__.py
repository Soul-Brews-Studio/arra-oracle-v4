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
    existing = set(db.table_names())
    drift = 0

    for name, model in TABLES.items():
        if name in existing and not reset:
            tbl = db.open_table(name)

            # models.py is the source of truth; disk is the thing that can be stale.
            declared = {f.name for f in model.to_arrow_schema()}
            on_disk = {f.name for f in tbl.schema}
            missing, extra = declared - on_disk, on_disk - declared
            if missing or extra:
                drift += 1
                print(f"DRIFT {name}: missing={sorted(missing)} extra={sorted(extra)}")
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
