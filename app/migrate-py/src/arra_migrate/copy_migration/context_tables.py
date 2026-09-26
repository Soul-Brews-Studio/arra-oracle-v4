"""Direct copy of the Honcho-shaped tables plus ``read_cursors``.

Each function takes the legacy rows (plain dicts, one table), records exactly
one outcome per row, and returns the target rows to append. A legacy row is
never mutated; a target row is a new dict in the TARGET field set.

Checks mirror what the TS stored-row codecs will demand on read, so a row that
would read back as ``integrity_failure`` is reported here instead of written:
nanoid21 ids (mapped), millisecond-exact times, a resolvable scope.
"""

from __future__ import annotations

from typing import Any

from .ids import IdCollision
from .state import CopyState
from .timestamps import first_sub_ms

Row = dict[str, Any]


def _sub_ms(state: CopyState, table: str, key: object, ws: str | None, row: Row, fields: tuple[str, ...]) -> bool:
    bad = first_sub_ms(row, fields)
    if bad is not None:
        state.rejected(table, key, ws, "sub_millisecond_timestamp", f"/{bad}",
                       detail=f"{row[bad].isoformat()} is not millisecond-exact; refusing to round")
        return True
    return False


def _assign(state: CopyState, table: str, key: object, ws: str, legacy_id: str) -> str | None:
    try:
        return state.ids.assign(table, ws, legacy_id)
    except IdCollision as error:
        state.rejected(table, key, ws, "id_collision", "/id", detail=str(error))
        return None


def copy_workspaces(rows: list[Row], state: CopyState) -> list[Row]:
    out = []
    for row in rows:
        ws = row["name"]
        if _sub_ms(state, "workspaces", row["id"], ws, row, ("created_at",)):
            continue
        if ws in state.workspaces:
            state.rejected("workspaces", row["id"], ws, "duplicate_name", "/name")
            continue
        # Workspace ids pass through: validateWorkspaceRow makes no nanoid decision.
        state.workspaces.add(ws)
        state.migrated("workspaces", row["id"], ws, row["id"])
        out.append(dict(row))
    return out


def _copy_named(table: str, rows: list[Row], state: CopyState, seen: set[tuple[str, str]]) -> list[Row]:
    out = []
    for row in rows:
        ws, key = row["workspace_name"], row["id"]
        if ws not in state.workspaces:
            state.unresolved(table, key, ws, "workspace_unresolved", "/workspace_name")
            continue
        if _sub_ms(state, table, key, ws, row, ("created_at",)):
            continue
        if (ws, row["name"]) in seen:
            state.rejected(table, key, ws, "duplicate_name", "/name")
            continue
        target = _assign(state, table, key, ws, key)
        if target is None:
            continue
        seen.add((ws, row["name"]))
        state.migrated(table, key, ws, target)
        out.append({**row, "id": target})
    return out


def copy_peers(rows: list[Row], state: CopyState) -> list[Row]:
    return _copy_named("peers", rows, state, state.peers)


def copy_sessions(rows: list[Row], state: CopyState) -> list[Row]:
    return _copy_named("sessions", rows, state, state.sessions)


def copy_session_peers(rows: list[Row], state: CopyState) -> list[Row]:
    out = []
    for row in rows:
        ws, session, peer = row["workspace_name"], row["session_name"], row["peer_name"]
        key = f"{ws}|{session}|{peer}"
        if ws not in state.workspaces:
            state.unresolved("session_peers", key, ws, "workspace_unresolved", "/workspace_name")
        elif (ws, session) not in state.sessions:
            state.unresolved("session_peers", key, ws, "session_unresolved", "/session_name")
        elif (ws, peer) not in state.peers:
            state.unresolved("session_peers", key, ws, "peer_unresolved", "/peer_name")
        elif not _sub_ms(state, "session_peers", key, ws, row, ("joined_at", "left_at")):
            state.migrated("session_peers", key, ws)
            out.append(dict(row))
    return out


def copy_messages(rows: list[Row], state: CopyState) -> list[Row]:
    """Legacy-boundary semantics (source-ingestion-v1 §8.3) applied to a copy.

    ``ingested_at`` is the ONE frozen migration intake time, never
    ``created_at``; the report carries the assumption string. A non-nanoid
    ``public_id`` is mapped and ``in_reply_to`` rewritten through the map; a
    reply whose target did not migrate keeps the message and reports the
    pointer unresolved.
    """

    accepted: list[Row] = []
    sequences: set[tuple[str, str, int]] = set()
    public_ids: set[tuple[str, str]] = set()
    for row in rows:
        ws, key = row["workspace_name"], row["id"]
        if ws not in state.workspaces:
            state.unresolved("messages", key, ws, "workspace_unresolved", "/workspace_name")
            continue
        if (ws, row["session_name"]) not in state.sessions:
            state.unresolved("messages", key, ws, "session_unresolved", "/session_name")
            continue
        if (ws, row["peer_name"]) not in state.peers:
            state.unresolved("messages", key, ws, "peer_unresolved", "/peer_name")
            continue
        if _sub_ms(state, "messages", key, ws, row, ("created_at", "read_at")):
            continue
        if row["token_count"] < 0:
            state.rejected("messages", key, ws, "invalid_value", "/token_count")
            continue
        seq = (ws, row["session_name"], row["seq_in_session"])
        if seq in sequences:
            state.rejected("messages", key, ws, "duplicate_sequence", "/seq_in_session")
            continue
        if (ws, row["public_id"]) in public_ids:
            state.rejected("messages", key, ws, "duplicate_public_id", "/public_id")
            continue
        target = _assign(state, "messages", key, ws, row["public_id"])
        if target is None:
            continue
        sequences.add(seq)
        public_ids.add((ws, row["public_id"]))
        state.messages[(ws, row["public_id"])] = target
        accepted.append(row)

    out = []
    for row in accepted:
        ws, key = row["workspace_name"], row["id"]
        reply = row["in_reply_to"]
        mapped_reply = state.messages.get((ws, reply)) if reply is not None else None
        if reply is not None:
            state.pointer("messages.in_reply_to", key, ws, mapped_reply is not None,
                          code="message_unresolved", detail=f"legacy in_reply_to={reply!r}")
        state.migrated("messages", key, ws, state.messages[(ws, row["public_id"])])
        out.append({
            **row,
            "public_id": state.messages[(ws, row["public_id"])],
            "in_reply_to": mapped_reply,
            "source_namespace": None,
            "source_message_id": None,
            "source_payload_digest": None,
            "source_created_at": None,
            "ingested_at": state.intake_at,
        })
    return out


def copy_read_cursors(rows: list[Row], state: CopyState) -> list[Row]:
    """Legacy cursors carry no workspace: derive it from the ONE workspace that
    has both the session and the peer, or report the cursor unresolved."""

    out = []
    for row in rows:
        peer, session = row["peer_name"], row["session_name"]
        key = f"{peer}|{session}"
        owners = sorted(ws for ws in state.workspaces
                        if (ws, session) in state.sessions and (ws, peer) in state.peers)
        if len(owners) != 1:
            code = "workspace_ambiguous" if owners else "session_unresolved"
            state.unresolved("read_cursors", key, None, code, "/session_name")
            continue
        ws = owners[0]
        if _sub_ms(state, "read_cursors", key, ws, row, ("last_read_at",)):
            continue
        legacy_pointer = row["last_read_message_id"]
        mapped = state.messages.get((ws, legacy_pointer)) if legacy_pointer is not None else None
        if legacy_pointer is not None and mapped is None:
            # read-cursor-v1: the pointer is a message public_id or nothing.
            state.unresolved("read_cursors", key, ws, "message_unresolved", "/last_read_message_id",
                             detail=f"legacy last_read_message_id={legacy_pointer!r}")
            continue
        state.migrated("read_cursors", key, ws)
        out.append({"workspace_name": ws, "peer_name": peer, "session_name": session,
                    "last_read_message_id": mapped, "last_read_at": row["last_read_at"]})
    return out
