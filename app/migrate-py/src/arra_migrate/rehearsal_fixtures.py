"""Deterministic fixture rows for the migration rehearsal (issue #34).

Plain-dict rows, one list per ACTIVE-15 table. No secrets.choice()/uuid4()
anywhere here -- a rehearsal that produces different ids on every run cannot
prove idempotency by comparing two runs' output. Split out of the rehearsal
module purely to keep files under the repo's line cap; nothing here changes
behaviour and nothing here is wired into any runtime route.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

T0 = datetime(2026, 9, 18, 12, 0, 0)  # naive UTC, matches the LanceModel convention

# The exact numbers from the measured facts: MS_VALUE is 9999-12-31T23:59:59.999Z
# in epoch milliseconds; MICROS_VALUE is the SAME instant in epoch microseconds.
# Multiplying MS_VALUE by 1000 to get "microseconds" is exactly the mis-scale
# the unit trap warns about when it is done to the WRONG column -- here it is
# done deliberately, to the RIGHT column, as the positive control.
MS_VALUE = 253402300799999
MICROS_VALUE = MS_VALUE * 1000
assert MICROS_VALUE == 253402300799999000  # pin the literal from the brief


def _source_rows() -> dict[str, list[dict[str, Any]]]:
    """Plain-dict rows, one list per ACTIVE-15 table, deterministic and fixed."""

    return {
        "workspaces": [
            {
                "id": "ws-01", "name": "ws-rehearsal", "created_at": T0,
                "h_metadata": None, "internal_metadata": None,
                "configuration": None, "mission": "disposable rehearsal workspace",
            },
        ],
        "peers": [
            {"id": "peer-01", "name": "nat", "workspace_name": "ws-rehearsal",
             "h_metadata": None, "internal_metadata": None, "configuration": None, "created_at": T0},
            {"id": "peer-02", "name": "neo", "workspace_name": "ws-rehearsal",
             "h_metadata": None, "internal_metadata": None, "configuration": None, "created_at": T0},
        ],
        "sessions": [
            {"id": "sess-01", "name": "session-one", "workspace_name": "ws-rehearsal",
             "is_active": True, "h_metadata": None, "internal_metadata": None,
             "configuration": None, "created_at": T0},
        ],
        "session_peers": [
            {"workspace_name": "ws-rehearsal", "session_name": "session-one", "peer_name": "nat",
             "configuration": None, "internal_metadata": None, "joined_at": T0, "left_at": None},
            {"workspace_name": "ws-rehearsal", "session_name": "session-one", "peer_name": "neo",
             "configuration": None, "internal_metadata": None, "joined_at": T0, "left_at": None},
        ],
        "messages": [
            {"id": 1, "public_id": "msg-pub-01", "workspace_name": "ws-rehearsal",
             "session_name": "session-one", "peer_name": "nat", "content": "ภาษาไทย 🌱 ทดสอบ",
             "token_count": 3, "seq_in_session": 1, "h_metadata": None, "internal_metadata": None,
             "created_at": T0, "role": "note", "in_reply_to": None, "read": None, "read_at": None},
            {"id": 2, "public_id": "msg-pub-02", "workspace_name": "ws-rehearsal",
             "session_name": "session-one", "peer_name": "neo", "content": "reply",
             "token_count": 1, "seq_in_session": 2, "h_metadata": None, "internal_metadata": None,
             "created_at": T0, "role": "answer", "in_reply_to": "msg-pub-01", "read": True,
             "read_at": T0},
        ],
        "memories": [
            {"id": "mem-01", "name": "old-memory", "workspace_name": "ws-rehearsal",
             "session_name": "session-one", "peer_name": "nat", "subject_peer_name": None,
             "type": "note", "content": "superseded content", "embedding": None,
             "created_at": T0, "valid_from": None, "valid_to": None,
             "sync_state": "pending", "last_sync_at": None, "sync_attempts": 0,
             "superseded_by": "mem-02", "superseded_at": T0, "is_active": False,
             "h_metadata": None, "internal_metadata": None},
            {"id": "mem-02", "name": "new-memory", "workspace_name": "ws-rehearsal",
             "session_name": "session-one", "peer_name": "nat", "subject_peer_name": None,
             "type": "note", "content": "current content", "embedding": None,
             "created_at": T0, "valid_from": T0, "valid_to": None,
             "sync_state": "pending", "last_sync_at": None, "sync_attempts": 0,
             "superseded_by": None, "superseded_at": None, "is_active": True,
             "h_metadata": None, "internal_metadata": None},
        ],
        "vocabularies": [
            {"id": "vocab-01", "name": "topic", "workspace_name": "ws-rehearsal",
             "label": "Topic", "description": None, "kind": "tags", "term_policy": "open",
             "h_metadata": None, "internal_metadata": None, "created_at": T0},
        ],
        "terms": [
            {"id": "term-01", "vocabulary_id": "vocab-01", "name": "oracle",
             "description": None, "parent_id": None, "weight": 1.0,
             "h_metadata": None, "created_at": T0},
        ],
        "memory_terms": [
            {"memory_id": "mem-02", "term_id": "term-01"},
        ],
        "supersede_log": [
            # reason=None on purpose -- the target REQUIRES it (see schema drift
            # audit); this is the row that exercises the backfill decision.
            {"id": 1, "workspace_name": "ws-rehearsal", "old_id": "mem-01",
             "old_title": "old-memory", "old_type": "note", "old_source": None,
             "new_id": "mem-02", "new_title": "new-memory", "new_source": None,
             "reason": None, "peer_name": "nat", "superseded_at": T0, "h_metadata": None},
        ],
        "traces": [
            {"id": "trace-01", "name": "0900_migration-rehearsal", "workspace_name": "ws-rehearsal",
             "session_name": "session-one", "peer_name": "nat", "query": "find the trap",
             "mode": "deep", "session_id": "ext-session-jsonl", "session_from_ts": MS_VALUE,
             "session_to_ts": MS_VALUE, "friction_score": 0.5, "confidence": "high",
             "parent_id": None, "prev_id": None, "depth": 0, "status": "raw",
             "distilled_to": None, "distilled_at": None, "h_metadata": None,
             "internal_metadata": None, "created_at": MS_VALUE, "updated_at": MS_VALUE},
        ],
        "trace_hits": [],  # never written historically -- schema only
        "mcp_calls": [
            {"id": "call-01", "workspace_name": "ws-rehearsal", "session_name": "session-one",
             "peer_name": "nat", "tool": "oracle_search", "status": "ok", "duration_ms": 42,
             "h_metadata": None, "internal_metadata": None, "created_at": MS_VALUE},
        ],
        "connections": [
            {"id": "conn-01", "workspace_name": "ws-rehearsal", "method": "mcp",
             "principal": "principal-01", "label": "claude", "user_agent": None,
             "remote_ip": None, "first_seen": T0, "last_seen": T0, "requests": 1,
             "tool_calls": 1, "last_tool": "oracle_search"},
        ],
        "read_cursors": [],  # never written historically -- schema only
    }
