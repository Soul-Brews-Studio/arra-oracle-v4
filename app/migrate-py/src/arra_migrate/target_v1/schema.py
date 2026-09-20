"""Physical Arrow schema description and drift rejection for the candidate.

Two jobs, no table creation:

1. ``describe_schema`` renders a ``pyarrow.Schema`` into a plain, reviewable
   list of ``[name, type, nullable]`` triples. The type vocabulary is small and
   language-neutral so the Bun side can render the same strings from Arrow JS
   and compare against the same checked-in golden file.

2. ``assert_schema_matches`` / ``open_table_checked`` reject an incompatible
   physical schema BEFORE any write. Drift is reported field by field.

Type vocabulary (exact strings):
  utf8 | large_utf8 | bool | int8..int64 | uint8..uint64 | float32 | float64
  timestamp[<unit>]            no timezone (the convention: UTC)
  timestamp[<unit>,<tz>]       a timezone is drift against the convention
  list<ITEM> / list<ITEM?>     ? marks a nullable element
  large_list<ITEM?>
  fixed_size_list<ITEM?>[N]

LARGE VARIANTS ARE DISTINCT, NOT SYNONYMS. ``utf8`` carries 32-bit offsets and
``large_utf8`` 64-bit; same for ``list`` vs ``large_list``. Rendering both as
one string silently accepts an incompatible persisted layout -- found by
independent review 2026-09-20 after the first draft of this module did exactly
that, and ``assert_schema_matches`` accepted Utf8->LargeUtf8 and
List->LargeList. Both are drift and both must be reported.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pyarrow as pa

FieldTriple = list  # [name: str, type: str, nullable: bool]


class SchemaDriftError(ValueError):
    """Raised when a physical schema does not match the expected one."""

    def __init__(self, table: str, problems: Sequence[str]) -> None:
        self.table = table
        self.problems = list(problems)
        super().__init__(f"schema drift in {table!r}: " + "; ".join(self.problems))


def describe_type(dtype: pa.DataType) -> str:
    """Render one Arrow type into the closed vocabulary above."""

    if pa.types.is_large_string(dtype):
        return "large_utf8"      # 64-bit offsets -- NOT interchangeable with utf8
    if pa.types.is_string(dtype):
        return "utf8"
    if pa.types.is_boolean(dtype):
        return "bool"
    if pa.types.is_integer(dtype):
        return str(dtype)  # int64, int32, uint8, ...
    if pa.types.is_float32(dtype):
        return "float32"
    if pa.types.is_float64(dtype):
        return "float64"
    if pa.types.is_timestamp(dtype):
        return f"timestamp[{dtype.unit}]" if dtype.tz is None else f"timestamp[{dtype.unit},{dtype.tz}]"
    if pa.types.is_fixed_size_list(dtype):
        item = dtype.value_field
        return f"fixed_size_list<{describe_type(item.type)}{'?' if item.nullable else ''}>[{dtype.list_size}]"
    if pa.types.is_large_list(dtype):
        item = dtype.value_field
        return f"large_list<{describe_type(item.type)}{'?' if item.nullable else ''}>"
    if pa.types.is_list(dtype):
        item = dtype.value_field
        return f"list<{describe_type(item.type)}{'?' if item.nullable else ''}>"
    return f"unsupported<{dtype}>"


def describe_schema(schema: pa.Schema) -> list[FieldTriple]:
    """Render a schema as ordered ``[name, type, nullable]`` triples."""

    return [[field.name, describe_type(field.type), bool(field.nullable)] for field in schema]


def diff_described(expected: Sequence[Sequence[Any]], actual: Sequence[Sequence[Any]]) -> list[str]:
    """Explain the differences between two described schemas. Empty = match.

    Reports missing fields, unexpected fields, type changes and nullability
    changes independently, so combined drift produces a combined report. Field
    ORDER is reported only when both sides carry the same set of names --
    otherwise the missing/unexpected lines already say what moved.
    """

    problems: list[str] = []
    expected_by_name = {row[0]: row for row in expected}
    actual_by_name = {row[0]: row for row in actual}
    for name in expected_by_name:
        if name not in actual_by_name:
            problems.append(f"missing field {name!r}")
    for name in actual_by_name:
        if name not in expected_by_name:
            problems.append(f"unexpected field {name!r}")
    for name, exp in expected_by_name.items():
        act = actual_by_name.get(name)
        if act is None:
            continue
        if exp[1] != act[1]:
            problems.append(f"{name}: type {act[1]!r} != expected {exp[1]!r}")
        if bool(exp[2]) != bool(act[2]):
            problems.append(f"{name}: nullable={act[2]!r} != expected {exp[2]!r}")
    # Report order drift whenever the NAME SETS agree. Gating on "no other
    # problem" would also hide a reorder that arrived alongside a type or
    # nullability change -- cases where the order line is still well-formed.
    # When names are missing or extra, the order line WOULD be redundant with
    # those messages, so it stays suppressed there.
    if set(expected_by_name) == set(actual_by_name):
        expected_order = [row[0] for row in expected]
        actual_order = [row[0] for row in actual]
        if expected_order != actual_order:
            problems.append(f"field order {actual_order} != expected {expected_order}")
    return problems


def assert_schema_matches(table: str, expected: Sequence[Sequence[Any]], actual: pa.Schema) -> None:
    """Raise ``SchemaDriftError`` unless *actual* renders exactly as *expected*."""

    problems = diff_described(expected, describe_schema(actual))
    if problems:
        raise SchemaDriftError(table, problems)


def open_table_checked(db: Any, table: str, expected: Sequence[Sequence[Any]]) -> Any:
    """Open an existing LanceDB table and verify its PERSISTED schema first.

    Reads the schema from the dataset on disk (not from a model), compares it,
    and returns the table only when it matches. Never writes. The caller gets
    a table it may write to, or an exception and an untouched dataset.
    """

    handle = db.open_table(table)
    assert_schema_matches(table, expected, handle.schema)
    return handle


__all__ = [
    "SchemaDriftError",
    "assert_schema_matches",
    "describe_schema",
    "describe_type",
    "diff_described",
    "open_table_checked",
]
