"""v4 tier-1 bundle -> plain SQL INSERTs for a stock Honcho v3.2.0 database.

Issue #8, ruling R15 (2026-09-27 table-level update). Applies EXACTLY the
conversions ``table_map.COLUMN_VERDICTS`` documents and nothing else:

  * ``h_metadata`` is written to Honcho's ``metadata`` column;
  * JSON text becomes ``jsonb`` (NULL -> ``'{}'``, the columns are NOT NULL);
  * a tz-naive v4 timestamp becomes an explicit UTC ``timestamptz``;
  * ``token_count`` is range-checked into ``integer``;
  * the messages identity sequence is moved past the imported ids;
  * columns stock Honcho has no slot for are dropped.

A value the Honcho table would reject (an id that is not nanoid21, U+0000 in
text, content over 65535 chars, a name over 512 chars, a token count outside
int32) raises ``IncompatibleValueError`` -- this module never rewrites a value
to make it fit, because a silent rewrite is exactly what a byte-compatibility
measurement must not contain.

The output is one transaction, meant for ``psql -v ON_ERROR_STOP=1`` inside
the disposable database container. Every value is a single-quoted literal
with quotes doubled under ``standard_conforming_strings = on``; nothing is
interpolated unquoted.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from .bundle import Tier1Bundle
from .table_map import COLUMN_VERDICTS, TIER1_TABLES, ColumnVerdict

_NANOID21 = re.compile(r"^[A-Za-z0-9_-]{21}$")
_INT32 = (-(2**31), 2**31 - 1)
_INT64 = (-(2**63), 2**63 - 1)
_CONTENT_MAX = 65535
_NAME_MAX = 512


class IncompatibleValueError(ValueError):
    """A v4 value that the stock Honcho table cannot hold unchanged."""


def _lit(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _text(v: ColumnVerdict, value: Any) -> str:
    where = f"{v.table}.{v.v4_column}"
    if not isinstance(value, str):
        raise IncompatibleValueError(f"{where}: expected text, got {type(value).__name__}")
    if "\x00" in value:
        raise IncompatibleValueError(f"{where}: U+0000 cannot be stored in a Postgres text column")
    if v.v4_column == "content" and len(value) > _CONTENT_MAX:
        raise IncompatibleValueError(f"{where}: {len(value)} chars > Honcho CHECK length(content) <= {_CONTENT_MAX}")
    if v.v4_column == "name" and len(value) > _NAME_MAX:
        raise IncompatibleValueError(f"{where}: {len(value)} chars > Honcho CHECK length(name) <= {_NAME_MAX}")
    return _lit(value)


def _int(v: ColumnVerdict, value: Any, bounds: tuple[int, int]) -> str:
    if not isinstance(value, int) or isinstance(value, bool):
        raise IncompatibleValueError(f"{v.table}.{v.v4_column}: expected an integer, got {value!r}")
    if not bounds[0] <= value <= bounds[1]:
        raise IncompatibleValueError(f"{v.table}.{v.v4_column}: {value} outside the Honcho column's range {bounds}")
    return str(value)


def _ts(v: ColumnVerdict, value: Any) -> str:
    if value is None:
        return "NULL"
    if not isinstance(value, datetime):
        raise IncompatibleValueError(f"{v.table}.{v.v4_column}: expected a timestamp, got {value!r}")
    aware = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return _lit(aware.astimezone(timezone.utc).isoformat(timespec="microseconds")) + "::timestamptz"


def _json(v: ColumnVerdict, value: Any) -> str:
    if value is None:
        return "'{}'::jsonb"
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    try:
        json.loads(text)
    except ValueError as exc:
        raise IncompatibleValueError(f"{v.table}.{v.v4_column}: not JSON text ({exc})") from None
    if "\x00" in text or "\\u0000" in text:
        raise IncompatibleValueError(f"{v.table}.{v.v4_column}: jsonb cannot store U+0000")
    return _lit(text) + "::jsonb"


def _value(v: ColumnVerdict, value: Any) -> str:
    if v.kind == "id":
        if not isinstance(value, str) or not _NANOID21.match(value):
            raise IncompatibleValueError(
                f"{v.table}.{v.v4_column}: {value!r} is not nanoid21 -- Honcho CHECK length = 21 AND "
                "^[A-Za-z0-9_-]+$ rejects it; map the id before the dump"
            )
        return _lit(value)
    if v.kind == "text":
        return _text(v, value)
    if v.kind in ("int", "identity"):
        return _int(v, value, _INT64)
    if v.kind == "int32":
        return _int(v, value, _INT32)
    if v.kind == "bool":
        if not isinstance(value, bool):
            raise IncompatibleValueError(f"{v.table}.{v.v4_column}: expected a boolean, got {value!r}")
        return "TRUE" if value else "FALSE"
    if v.kind == "ts":
        return _ts(v, value)
    if v.kind == "json":
        return _json(v, value)
    raise AssertionError(f"unhandled kind {v.kind!r}")


def bundle_to_honcho_sql(bundle: Tier1Bundle) -> str:
    """One ``BEGIN; ... COMMIT;`` script inserting *bundle* into stock Honcho
    tables, in FK order (workspaces, peers, sessions, session_peers, messages)."""

    lines = ["BEGIN;", "SET LOCAL standard_conforming_strings = on;"]
    for table in TIER1_TABLES:
        kept = [v for v in COLUMN_VERDICTS if v.table == table and v.honcho_column is not None]
        cols = ", ".join(f'"{v.honcho_column}"' for v in kept)
        for row in getattr(bundle, table):
            values = ", ".join(_value(v, row.get(v.v4_column)) for v in kept)
            lines.append(f'INSERT INTO "{table}" ({cols}) VALUES ({values});')
    lines.append("SELECT setval(pg_get_serial_sequence('messages', 'id'), (SELECT max(id) FROM messages));")
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"
