"""Scratch-only Python -> LanceDB/Arrow -> Bun fixture for the target-19 candidate.

Creates all 19 candidate tables under a temporary root, writes the reviewed
sample rows, and prints a proof document on stdout. Never imported by the
migrator, never touches a live dataset, never calls a model or the network.

The golden schema is READ, never written: this script must not be able to make
a drifted model look correct by regenerating what it compares against.
"""

import json
import sys
from pathlib import Path

import lancedb
import pyarrow as pa
from arra_migrate.contract_v1 import parse_int64, parse_timestamp
from arra_migrate.target_v1 import (
    TARGET_REGISTRY_VERSION,
    TARGET_TABLE_NAMES,
    TARGET_TABLES,
)
from arra_migrate.target_v1.schema import describe_schema

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "target-v1"
GOLDEN = FIXTURES / "golden-schema.json"
SAMPLES = FIXTURES / "sample-rows.json"


def _decode(model, row):
    """Turn the fixture's wire encoding into Python values for the model."""
    decoded = {}
    for name in model.model_fields:
        value = row[name]
        described = _declared(model, name)
        if value is None:
            decoded[name] = None
        elif described.startswith("timestamp["):
            # Physical column is timestamp[us] WITHOUT timezone; store the UTC
            # instant as naive UTC so the persisted type stays tz-free.
            decoded[name] = parse_timestamp(value).replace(tzinfo=None)
        elif described == "int64":
            decoded[name] = parse_int64(value)
        else:
            decoded[name] = value
    return model(**decoded)


_DECLARED: dict[str, dict[str, str]] = {}


def _declared(model, field_name):
    key = model.__name__
    if key not in _DECLARED:
        _DECLARED[key] = {name: dtype for name, dtype, _ in describe_schema(model.to_arrow_schema())}
    return _DECLARED[key][field_name]


def db_probe(root: Path) -> dict:
    """Persist large_string and large_list columns for the cross-language test."""
    target = root / "drift-probe-lancedb"
    target.mkdir(exist_ok=False)
    db = lancedb.connect(str(target))
    created = {}
    for name, dtype, value in [
        ("large_utf8_probe", pa.large_string(), "x"),
        ("large_list_probe", pa.large_list(pa.string()), ["x"]),
    ]:
        schema = pa.schema([pa.field("v", dtype, nullable=False)])
        table = db.create_table(name, schema=schema)
        table.add(pa.table({"v": pa.array([value], type=dtype)}, schema=schema))
        created[name] = str(db.open_table(name).schema.field("v").type)
    return created


def main():
    root = Path(sys.argv[1]).resolve()
    target = root / "target-v1-lancedb"
    # No overwrite/reset mode, including on retry.
    target.mkdir(exist_ok=False)

    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    samples = json.loads(SAMPLES.read_text(encoding="utf-8"))["tables"]

    db = lancedb.connect(str(target))
    persisted = {}
    counts = {}
    for name in TARGET_TABLE_NAMES:
        model = TARGET_TABLES[name]
        table = db.create_table(name, schema=model)
        table.add([_decode(model, row) for row in samples[name]])
        # Reopen so the schema read comes from the dataset on disk, not from
        # the handle that just created it.
        reopened = db.open_table(name)
        persisted[name] = describe_schema(reopened.schema)
        counts[name] = reopened.count_rows()

    # A REAL persisted offset-width probe, so the Bun side can test large
    # variants against an actual dataset instead of a hand-built stub.
    # LanceDB accepts both; Arrow JS can read only one of them (measured).
    probe = db_probe(root)

    print(json.dumps({
        "registry_version": TARGET_REGISTRY_VERSION,
        "drift_probe": probe,
        "golden_registry_version": golden["registry_version"],
        "tables": list(TARGET_TABLE_NAMES),
        "persisted_schema": persisted,
        "row_counts": counts,
        "golden_matches_persisted": golden["tables"] == {k: [list(f) for f in v] for k, v in persisted.items()},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
