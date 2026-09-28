"""Create the tables of ONE registry at ARRA_DATA_DIR. Idempotent; never reads rows.

    uv run arra-migrate                      # target-19 (the default since R32)
    uv run arra-migrate --legacy-active15    # the legacy 15, for the legacy routes only
    uv run arra-migrate --ops                # exactly mcp_calls/connections/instance_audit @ ARRA_OPS_DIR
    ARRA_RESET=1 uv run arra-migrate         # recreate (old versions stay -- Lance deletes nothing)
    uv run arra-migrate --check              # exit 1 if disk disagrees with the selected registry

R33 S4(a) (Nat 2026-09-28, docs/overnight/DECISIONS.md): ``--ops`` creates
ONLY the three operations tables, at ``ARRA_OPS_DIR`` (falls back to
``ARRA_DATA_DIR`` when unset, same as the TS server). It reuses the existing
``mcp_call``/``connection`` model declarations and the standalone
``instance_audit`` model unchanged -- no new schema is invented here. Like
the other two modes, it refuses a root that already holds a table from
either tenant registry (legacy-15 or target-19): the ops root is for
operations tables only.

R32 (Nat 2026-09-28, #135; docs/overnight/DECISIONS.md): the cutover rehearsal
found no live v4 data, so v4 starts fresh on target-19 and nothing is migrated.
The default registry is ``target_v1.TARGET_TABLES`` -- the dataset the server
mounts as ``ARRA_KNOWLEDGE_DATASET_ROOT``. The legacy ``models.TABLES`` set is
still created, but only on request: the server's legacy ``/api/memories``
routes and startup FTS work open ``memories`` in ``ARRA_DATA_DIR``.

A root that already holds tables only the OTHER registry declares is refused
before anything is created. Without that, re-running the bare command on an
existing legacy dataset (the old default) would bolt six target tables onto it.
"""

import argparse
import os
import sys

import lancedb

from .models import TABLES as LEGACY_ACTIVE15_TABLES
from .models.connection import TABLE as CONNECTIONS_TABLE, Connection
from .models.instance_audit import TABLE as INSTANCE_AUDIT_TABLE, InstanceAudit
from .models.mcp_call import TABLE as MCP_CALLS_TABLE, McpCall
from .storage import DATA_DIR, OPS_DIR, describe, describe_ops, ops_storage_options, storage_options
from .target_v1 import TARGET_TABLES

LEGACY_FLAG = "--legacy-active15"
OPS_FLAG = "--ops"
OPS_TABLES = {
    MCP_CALLS_TABLE: McpCall,
    CONNECTIONS_TABLE: Connection,
    INSTANCE_AUDIT_TABLE: InstanceAudit,
}


def _print_schema(tbl) -> None:
    for f in tbl.schema:
        null = "" if not f.nullable else "  null"
        print(f"  {f.name:<20} {f.type}{null}")


def main(argv: list[str] | None = None) -> int:
    # allow_abbrev=False: argparse would otherwise take `--legacy` as an
    # abbreviation of the flag, and an abbreviation is how a typo becomes a
    # silent registry choice.
    parser = argparse.ArgumentParser(
        prog="arra-migrate", description=__doc__.split("\n\n")[0], allow_abbrev=False,
    )
    parser.add_argument("--check", action="store_true", help="exit 1 if disk disagrees with the selected registry")
    parser.add_argument(LEGACY_FLAG, dest="legacy", action="store_true",
                        help="create the legacy active-15 registry instead of target-19")
    parser.add_argument(OPS_FLAG, dest="ops", action="store_true",
                        help="create exactly mcp_calls/connections/instance_audit at ARRA_OPS_DIR")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.ops and args.legacy:
        print(f"refused: {OPS_FLAG} and {LEGACY_FLAG} are mutually exclusive", file=sys.stderr)
        return 2
    check_only = args.check
    reset = bool(os.environ.get("ARRA_RESET"))

    if args.ops:
        tables, label = OPS_TABLES, "ops"
        root, opts = OPS_DIR, ops_storage_options()
        # A root already holding ANY tenant table (either registry) is not an
        # ops root -- refuse rather than bolt operations tables onto a
        # knowledge/legacy dataset.
        foreign_names = (set(TARGET_TABLES) | set(LEGACY_ACTIVE15_TABLES)) - set(tables)
        print(f"store: {describe_ops()}  registry: {label}")
    else:
        tables, label = (LEGACY_ACTIVE15_TABLES, "legacy-active15") if args.legacy else (TARGET_TABLES, "target-19")
        root, opts = DATA_DIR, storage_options()
        other = TARGET_TABLES if args.legacy else LEGACY_ACTIVE15_TABLES
        foreign_names = set(other) - set(tables)
        print(f"store: {describe()}  registry: {label}")
    db = lancedb.connect(root, storage_options=opts)

    # `table_names()` PAGINATES, defaulting to 10. With 15 tables the tail came
    # back missing, so the "already exists" check below said absent and the
    # overwrite would have destroyed tables 11-15 on every re-run. Ask for more
    # than can exist, and assert we did not hit the ceiling anyway.
    existing = set(db.table_names(limit=1000))
    if len(existing) >= 1000:
        raise RuntimeError("table listing hit the page limit; raise it before trusting this")

    foreign = sorted(existing & foreign_names)
    if foreign:
        if args.ops:
            hint = "use a new empty root for ARRA_OPS_DIR"
        else:
            hint = "drop the flag" if args.legacy else f"pass {LEGACY_FLAG}"
        print(
            f"refused: {root} holds {foreign}, which only the other registry declares. "
            f"This is not a {label} dataset; {hint} to work on it, or use a new empty root. "
            "Nothing was created.",
            file=sys.stderr,
        )
        return 2

    drift = 0

    for name, model in tables.items():
        if name in existing and not reset:
            tbl = db.open_table(name)

            # The registry is the source of truth; disk is the thing that can be stale.
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
            print(f"MISSING {name}: declared in the {label} registry, absent on disk")
            continue

        tbl = db.create_table(name, schema=model, mode="overwrite")
        print(f"created {name} @ {root}/{name}.lance")
        _print_schema(tbl)

    if check_only and drift:
        print(f"\n{drift} table(s) disagree with the {label} registry", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
