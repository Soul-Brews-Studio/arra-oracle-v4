"""Column-by-column map: v4 target-19 tier-1 -> stock Honcho v3.2.0 Postgres.

Issue #8, ruling R15 (2026-09-27 table-level update). The historical SPEC
§15.2 invariant 1 says v4's tier-1 tables are byte-compatible with Honcho's,
so a bank exports as a plain table dump. This module is the measured answer,
one row per column, and ``docs/overnight/HONCHO-TABLE-DIFF.md`` is its prose.

``HONCHO_V3_2_0_COLUMNS`` was captured from the LIVE database of a disposable
Honcho at the pinned commit (``pin.HONCHO_V3_2_0``) -- ``information_schema.
columns`` after Honcho's own alembic migrations ran -- not from ``models.py``
(the ORM declares ``h_metadata``; the SQL column is ``metadata``, which is the
single most important fact here). ``TestLiveTableRoundTrip`` re-reads the
live schema on every run and fails if it differs from this constant.

Verdicts:
  exact         same column name, compatible type and nullability, and every
                value v4 can hold is one Honcho accepts, unchanged.
  convertible   a documented, deterministic conversion is needed (the
                ``note`` says which); ``table_sql`` applies exactly that.
  incompatible  no stock Honcho column, or no conversion that keeps the value.

``EXPECTED_OUTCOMES`` is what the live table-level round trip measured for
each v4 column: ``rest`` is the read-back through Honcho's REST API,
``table`` the read-back through SQL. ``exact`` = the same Python value
(strings: the same code points, hence the same UTF-8 bytes); ``converted`` =
equal only after the documented conversion; ``not-exposed`` = the REST API
has no field for it; ``lost`` = no stock Honcho column holds it.
"""

from __future__ import annotations

from dataclasses import dataclass

TIER1_TABLES = ("workspaces", "peers", "sessions", "session_peers", "messages")


@dataclass(frozen=True)
class HonchoColumn:
    name: str
    data_type: str
    nullable: bool
    default: str = ""


_TEXT = "text"
_TSTZ = "timestamp with time zone"
_JSONB = "jsonb"
_EMPTY = "'{}'::jsonb"


def _json(name: str) -> HonchoColumn:
    return HonchoColumn(name, _JSONB, False, _EMPTY)


# Measured 2026-09-27, Postgres 15.19 in the pinned compose's `database`
# service, after the api container's alembic upgrade.
HONCHO_V3_2_0_COLUMNS: dict[str, tuple[HonchoColumn, ...]] = {
    "workspaces": (
        HonchoColumn("id", _TEXT, False), HonchoColumn("name", _TEXT, False),
        HonchoColumn("created_at", _TSTZ, False, "now()"),
        _json("metadata"), _json("configuration"), _json("internal_metadata"),
    ),
    "peers": (
        HonchoColumn("id", _TEXT, False), HonchoColumn("name", _TEXT, False),
        HonchoColumn("workspace_name", _TEXT, False),
        HonchoColumn("created_at", _TSTZ, False, "now()"),
        _json("metadata"), _json("configuration"), _json("internal_metadata"),
    ),
    "sessions": (
        HonchoColumn("id", _TEXT, False), HonchoColumn("name", _TEXT, False),
        HonchoColumn("workspace_name", _TEXT, False),
        HonchoColumn("is_active", "boolean", False, "true"),
        HonchoColumn("created_at", _TSTZ, False, "now()"),
        _json("metadata"), _json("configuration"), _json("internal_metadata"),
    ),
    "session_peers": (
        HonchoColumn("workspace_name", _TEXT, False), HonchoColumn("session_name", _TEXT, False),
        HonchoColumn("peer_name", _TEXT, False),
        _json("configuration"), _json("internal_metadata"),
        HonchoColumn("joined_at", _TSTZ, False, "now()"), HonchoColumn("left_at", _TSTZ, True),
    ),
    "messages": (
        HonchoColumn("id", "bigint", False), HonchoColumn("public_id", _TEXT, False),
        HonchoColumn("workspace_name", _TEXT, False), HonchoColumn("session_name", _TEXT, False),
        HonchoColumn("peer_name", _TEXT, False), HonchoColumn("content", _TEXT, False),
        HonchoColumn("token_count", "integer", False, "0"), HonchoColumn("seq_in_session", "bigint", False),
        HonchoColumn("created_at", _TSTZ, False, "now()"),
        _json("metadata"), _json("internal_metadata"),
    ),
}


@dataclass(frozen=True)
class ColumnVerdict:
    table: str
    v4_column: str | None
    honcho_column: str | None
    verdict: str
    kind: str  # how table_sql writes it: id | text | int | int32 | bool | ts | json | identity | drop
    note: str = ""


_TS = "timestamp[us] (tz-naive, UTC by v4 convention) -> timestamptz: attach +00:00; both sides keep microseconds."
_JSON = (
    "utf8 JSON text -> jsonb: parse; NULL -> '{}' (Honcho column is NOT NULL). The JSON value survives; "
    "the text bytes do not (jsonb re-orders keys, drops whitespace and duplicate keys), and NULL vs {} collapses."
)
_META = "rename h_metadata -> metadata (h_metadata is only Honcho's SQLAlchemy attribute name) + " + _JSON
_ID21 = (
    "Honcho CHECK length(id) = 21 AND id ~ '^[A-Za-z0-9_-]+$'. v4 requires nanoid21 here "
    "(context-ingestion-v1 registerPeer/registerSession), so every contract-valid value passes unchanged."
)
_WS_ID = (
    "Honcho CHECK length(id) = 21 AND id ~ '^[A-Za-z0-9_-]+$'; v4 does NOT constrain workspaces.id "
    "(its own dev seed `ws_default_devseed`, 18 chars, is rejected). Passes unchanged only when the value is "
    "already nanoid21; otherwise it needs an id map before the dump. table_sql refuses rather than rewrites."
)
_NAME = "text NOT NULL. Honcho CHECK length(name) <= 512 chars; v4 names are <= 256 UTF-8 bytes. The REST-only pattern ^[a-zA-Z0-9_-]+$ is NOT a table constraint."
_DROP = "no column in stock Honcho; a plain INSERT naming it fails ('column ... does not exist'). Dropped from the dump."
_DROP_P = "[P] source-identity addition (DESIGN.md §5). " + _DROP
_V4_ONLY = "+v4 addition. " + _DROP

COLUMN_VERDICTS: tuple[ColumnVerdict, ...] = (
    ColumnVerdict("workspaces", "id", "id", "convertible", "id", _WS_ID),
    ColumnVerdict("workspaces", "name", "name", "exact", "text", _NAME + " UNIQUE on both sides."),
    ColumnVerdict("workspaces", "created_at", "created_at", "convertible", "ts", _TS),
    ColumnVerdict("workspaces", "h_metadata", "metadata", "convertible", "json", _META),
    ColumnVerdict("workspaces", "internal_metadata", "internal_metadata", "convertible", "json", _JSON),
    ColumnVerdict("workspaces", "configuration", "configuration", "convertible", "json", _JSON),
    ColumnVerdict("workspaces", "mission", None, "incompatible", "drop", _V4_ONLY),

    ColumnVerdict("peers", "id", "id", "exact", "id", _ID21),
    ColumnVerdict("peers", "name", "name", "exact", "text", _NAME + " UNIQUE (name, workspace_name) on both sides."),
    ColumnVerdict("peers", "workspace_name", "workspace_name", "exact", "text", "text NOT NULL, FK -> workspaces.name."),
    ColumnVerdict("peers", "h_metadata", "metadata", "convertible", "json", _META),
    ColumnVerdict("peers", "internal_metadata", "internal_metadata", "convertible", "json", _JSON),
    ColumnVerdict("peers", "configuration", "configuration", "convertible", "json", _JSON),
    ColumnVerdict("peers", "created_at", "created_at", "convertible", "ts", _TS),

    ColumnVerdict("sessions", "id", "id", "exact", "id", _ID21),
    ColumnVerdict("sessions", "name", "name", "exact", "text", _NAME + " UNIQUE (name, workspace_name)."),
    ColumnVerdict("sessions", "workspace_name", "workspace_name", "exact", "text", "text NOT NULL, FK -> workspaces.name."),
    ColumnVerdict("sessions", "is_active", "is_active", "exact", "bool", "bool NOT NULL -> boolean NOT NULL DEFAULT true."),
    ColumnVerdict("sessions", "h_metadata", "metadata", "convertible", "json", _META),
    ColumnVerdict("sessions", "internal_metadata", "internal_metadata", "convertible", "json", _JSON),
    ColumnVerdict("sessions", "configuration", "configuration", "convertible", "json", _JSON),
    ColumnVerdict("sessions", "created_at", "created_at", "convertible", "ts", _TS),

    ColumnVerdict("session_peers", "workspace_name", "workspace_name", "exact", "text", "PK part; FK -> workspaces.name."),
    ColumnVerdict("session_peers", "session_name", "session_name", "exact", "text", "PK part; FK (session_name, workspace_name) -> sessions."),
    ColumnVerdict("session_peers", "peer_name", "peer_name", "exact", "text", "PK part; FK (peer_name, workspace_name) -> peers."),
    ColumnVerdict("session_peers", "configuration", "configuration", "convertible", "json", _JSON),
    ColumnVerdict("session_peers", "internal_metadata", "internal_metadata", "convertible", "json", _JSON),
    ColumnVerdict("session_peers", "joined_at", "joined_at", "convertible", "ts", _TS),
    ColumnVerdict("session_peers", "left_at", "left_at", "convertible", "ts", _TS + " NULL stays NULL (nullable on both sides)."),

    ColumnVerdict(
        "messages", "id", "id", "convertible", "identity",
        "int64 -> bigint GENERATED BY DEFAULT AS IDENTITY: the explicit value is accepted unchanged, but the "
        "identity sequence must then be moved past max(id) (setval), or Honcho's next REST write collides on pk_messages. "
        "Unchanged ONLY into a database holding no overlapping id: v4's id is per-dataset legacy order (1..n), Honcho's is "
        "one identity for the whole database, so a second bank (or any Honcho that already has messages) collides on "
        "pk_messages -- measured -- and would need renumbering, which loses the v4 value.",
    ),
    ColumnVerdict("messages", "public_id", "public_id", "exact", "id", "nanoid21 on both sides (CHECK length = 21 + pattern; UNIQUE)."),
    ColumnVerdict("messages", "workspace_name", "workspace_name", "exact", "text", "FKs (session_name|peer_name, workspace_name) -> sessions|peers."),
    ColumnVerdict("messages", "session_name", "session_name", "exact", "text", "composite FK -> sessions."),
    ColumnVerdict("messages", "peer_name", "peer_name", "exact", "text", "composite FK -> peers."),
    ColumnVerdict(
        "messages", "content", "content", "exact", "text",
        "text NOT NULL; Honcho CHECK length(content) <= 65535. Postgres text cannot store U+0000: such a value is refused, not stripped.",
    ),
    ColumnVerdict("messages", "token_count", "token_count", "convertible", "int32", "int64 -> integer (int32): narrowing, range-checked; a value outside int32 is refused."),
    ColumnVerdict("messages", "seq_in_session", "seq_in_session", "exact", "int", "int64 -> bigint; UNIQUE (workspace_name, session_name, seq_in_session) in Honcho only."),
    ColumnVerdict("messages", "h_metadata", "metadata", "convertible", "json", _META),
    ColumnVerdict("messages", "internal_metadata", "internal_metadata", "convertible", "json", _JSON),
    ColumnVerdict("messages", "created_at", "created_at", "convertible", "ts", _TS),
    ColumnVerdict("messages", "role", None, "incompatible", "drop", _V4_ONLY),
    ColumnVerdict("messages", "in_reply_to", None, "incompatible", "drop", _V4_ONLY),
    ColumnVerdict("messages", "read", None, "incompatible", "drop", _V4_ONLY),
    ColumnVerdict("messages", "read_at", None, "incompatible", "drop", _V4_ONLY),
    ColumnVerdict("messages", "source_namespace", None, "incompatible", "drop", _DROP_P),
    ColumnVerdict("messages", "source_message_id", None, "incompatible", "drop", _DROP_P),
    ColumnVerdict("messages", "source_payload_digest", None, "incompatible", "drop", _DROP_P),
    ColumnVerdict("messages", "source_created_at", None, "incompatible", "drop", _DROP_P),
    ColumnVerdict(
        "messages", "ingested_at", None, "incompatible", "drop",
        "target-19 addition, NOT NULL (the recorded §15.1 exception, R15). " + _DROP,
    ),
)

VERDICT_INDEX: dict[tuple[str, str], ColumnVerdict] = {
    (v.table, v.v4_column): v for v in COLUMN_VERDICTS if v.v4_column is not None
}

# REST field that carries each v4 column in Honcho's response schemas
# (src/schemas/api.py at the pin: Workspace/Peer/Session/Message). A column
# missing here has no REST field. session_peers has no row-level read route:
# GET .../sessions/{id}/peers returns Peer objects, i.e. membership only.
REST_FIELDS: dict[tuple[str, str], str] = {
    ("workspaces", "name"): "id", ("workspaces", "created_at"): "created_at",
    ("workspaces", "h_metadata"): "metadata", ("workspaces", "configuration"): "configuration",
    ("peers", "name"): "id", ("peers", "workspace_name"): "workspace_id", ("peers", "created_at"): "created_at",
    ("peers", "h_metadata"): "metadata", ("peers", "configuration"): "configuration",
    ("sessions", "name"): "id", ("sessions", "workspace_name"): "workspace_id", ("sessions", "is_active"): "is_active",
    ("sessions", "created_at"): "created_at", ("sessions", "h_metadata"): "metadata",
    ("sessions", "configuration"): "configuration",
    ("session_peers", "workspace_name"): "workspace_id", ("session_peers", "session_name"): "session_id",
    ("session_peers", "peer_name"): "id",
    ("messages", "public_id"): "id", ("messages", "workspace_name"): "workspace_id",
    ("messages", "session_name"): "session_id", ("messages", "peer_name"): "peer_id",
    ("messages", "content"): "content", ("messages", "token_count"): "token_count",
    ("messages", "created_at"): "created_at", ("messages", "h_metadata"): "metadata",
}


def _outcome(rest: str, table: str) -> dict[str, str]:
    return {"rest": rest, "table": table}


def _expected() -> dict[tuple[str, str], dict[str, str]]:
    out: dict[tuple[str, str], dict[str, str]] = {}
    for v in COLUMN_VERDICTS:
        if v.v4_column is None:
            continue
        key = (v.table, v.v4_column)
        if v.kind == "drop":
            out[key] = _outcome("not-exposed", "lost")
            continue
        table = "converted" if v.kind in ("ts", "json") else "exact"
        rest = "not-exposed" if key not in REST_FIELDS else table
        out[key] = _outcome(rest, table)
    return out


EXPECTED_OUTCOMES: dict[tuple[str, str], dict[str, str]] = _expected()
