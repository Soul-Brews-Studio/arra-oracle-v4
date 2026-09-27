"""A realistic LEGACY-15 source for the #34 copy-migration rehearsal.

Built with the ACTIVE registry (``arra_migrate.models``), the exact physical
shape the running spike serves, into a directory the caller owns (a fresh
``mktemp -d`` in every test). Nothing here touches ``app/.tmp``, ``app/data``
or any running service.

The rows are chosen to exercise every branch the copy migration must REPORT
rather than silently drop:

  - Thai and English memories; one already carries a legacy vector.
  - legacy ``type`` values that are reserved terms (kept) and free text
    (R11: become ``note`` + a tag term holding the original string), and one
    free-text type too long to be a term name (rejected alone, not its workspace).
  - tags through ``memory_terms``, including an orphan term whose vocabulary
    does not exist, a legacy vocabulary that collides with reserved ``type``, a
    term with a legacy PARENT (R17 flat: the parent is dropped and reported),
    a term name over the kernel's 256-byte limit, and a sealed ``project``
    vocabulary (R18 D2 names it an adapter vocabulary).
  - supersede rows with and without a reason (R17 backfill), a retirement, a
    log row whose old memory does not exist, and a ``superseded_by`` with NO
    log row (one event is synthesized and counted).
  - messages with non-nanoid legacy public ids, a reply chain, a dangling reply
    and one SUB-MILLISECOND ``created_at`` that must be rejected with a report
    entry instead of rounded.
  - traces with ``distilled_to`` pointing at a real and at a missing memory,
    and a ``raw`` trace (R17: ``raw -> open``) carrying a ``url`` hit whose kind
    is inside ``TARGET_KINDS`` (unresolved: no structured locator is invented).

Every timestamp except the deliberate sub-ms ones is millisecond-exact.

    python tests/export_legacy_fixture.py <empty-dir>   # prints the JSON summary
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import lancedb
from arra_migrate.models import TABLES

LAB = "oracle-lab"
SIDE = "side-bank"
T0 = datetime(2026, 9, 20, 8, 30, 0, 123000)  # noqa: DTZ001 -- ms-exact, naive UTC (LanceModel convention)
MS0 = 1789893000123                             # the same instant, epoch ms


def at(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


def ms(minutes: int) -> int:
    return MS0 + minutes * 60_000


SUB_MS = datetime(2026, 9, 20, 9, 0, 0, 123456)  # noqa: DTZ001 -- .123456: NOT millisecond-exact
VECTOR = [0.125] * 384
SIDE_WORKSPACE_ID = "Sd0bAnkWorkspace00001"      # already nanoid21: kept as-is
SIDE_NANOID_PUBLIC_ID = "RePlyNan0id0000000001"  # already nanoid21: kept as-is
#: A free-text type someone filled with prose: 316 UTF-8 bytes, over the
#: kernel's 256-byte term-name limit (taxonomy.requireName.ts).
LONG_TYPE = "บันทึกการประชุมเรื่องกุญแจ " * 4


def _memory(mid: str, name: str, content: str, type_: str, minutes: int, **extra: Any) -> dict[str, Any]:
    row = {
        "id": mid, "name": name, "workspace_name": LAB, "session_name": None,
        "peer_name": "nat", "subject_peer_name": None, "type": type_, "content": content,
        "embedding": None, "created_at": at(minutes), "valid_from": None, "valid_to": None,
        "sync_state": "pending", "last_sync_at": None, "sync_attempts": 0,
        "superseded_by": None, "superseded_at": None, "is_active": True,
        "h_metadata": None, "internal_metadata": None,
    }
    row.update(extra)
    return row


def legacy_rows() -> dict[str, list[dict[str, Any]]]:
    """Plain dict rows, one list per ACTIVE-15 table. Deterministic."""

    return {
        "workspaces": [
            {"id": "ws-lab", "name": LAB, "created_at": at(0), "h_metadata": None,
             "internal_metadata": None, "configuration": None, "mission": "ห้องทดลองความจำ"},
            {"id": SIDE_WORKSPACE_ID, "name": SIDE, "created_at": at(0), "h_metadata": None,
             "internal_metadata": None, "configuration": None, "mission": None},
        ],
        "peers": [
            {"id": "peer-nat", "name": "nat", "workspace_name": LAB, "h_metadata": None,
             "internal_metadata": None, "configuration": None, "created_at": at(1)},
            {"id": "peer-neo", "name": "neo", "workspace_name": LAB, "h_metadata": None,
             "internal_metadata": None, "configuration": None, "created_at": at(1)},
            {"id": "peer-ghost", "name": "ghost", "workspace_name": SIDE, "h_metadata": None,
             "internal_metadata": None, "configuration": None, "created_at": at(1)},
        ],
        "sessions": [
            {"id": "sess-alpha", "name": "session-alpha", "workspace_name": LAB, "is_active": True,
             "h_metadata": None, "internal_metadata": None, "configuration": None, "created_at": at(2)},
            {"id": "sess-side", "name": "session-side", "workspace_name": SIDE, "is_active": True,
             "h_metadata": None, "internal_metadata": None, "configuration": None, "created_at": at(2)},
        ],
        "session_peers": [
            {"workspace_name": LAB, "session_name": "session-alpha", "peer_name": "nat",
             "configuration": None, "internal_metadata": None, "joined_at": at(3), "left_at": None},
            {"workspace_name": LAB, "session_name": "session-alpha", "peer_name": "neo",
             "configuration": None, "internal_metadata": None, "joined_at": at(3), "left_at": at(90)},
            {"workspace_name": SIDE, "session_name": "session-side", "peer_name": "ghost",
             "configuration": None, "internal_metadata": None, "joined_at": at(3), "left_at": None},
            # Membership of a peer that was never registered: rejected, reported.
            {"workspace_name": LAB, "session_name": "session-alpha", "peer_name": "nobody",
             "configuration": None, "internal_metadata": None, "joined_at": at(3), "left_at": None},
        ],
        "messages": [
            {"id": 1, "public_id": "msg-001", "workspace_name": LAB, "session_name": "session-alpha",
             "peer_name": "nat", "content": "ลืมกุญแจไว้ที่บ้านอีกแล้ว", "token_count": 7, "seq_in_session": 1,
             "h_metadata": None, "internal_metadata": None, "created_at": at(10), "role": "note",
             "in_reply_to": None, "read": None, "read_at": None},
            {"id": 2, "public_id": "msg-002", "workspace_name": LAB, "session_name": "session-alpha",
             "peer_name": "neo", "content": "Check the drawer by the door.", "token_count": 6,
             "seq_in_session": 2, "h_metadata": None, "internal_metadata": None, "created_at": at(11),
             "role": "answer", "in_reply_to": "msg-001", "read": True, "read_at": at(12)},
            # SUB-MILLISECOND: must be rejected with a report entry, never rounded.
            {"id": 3, "public_id": "msg-003", "workspace_name": LAB, "session_name": "session-alpha",
             "peer_name": "nat", "content": "timestamp written by a microsecond clock",
             "token_count": 5, "seq_in_session": 3, "h_metadata": None, "internal_metadata": None,
             "created_at": SUB_MS, "role": "note", "in_reply_to": None, "read": None, "read_at": None},
            # Dangling reply: the message survives, the pointer is reported unresolved.
            {"id": 4, "public_id": "msg-004", "workspace_name": LAB, "session_name": "session-alpha",
             "peer_name": "neo", "content": "replying to something that is gone", "token_count": 6,
             "seq_in_session": 4, "h_metadata": None, "internal_metadata": None, "created_at": at(13),
             "role": "answer", "in_reply_to": "msg-404", "read": None, "read_at": None},
            {"id": 5, "public_id": SIDE_NANOID_PUBLIC_ID, "workspace_name": SIDE,
             "session_name": "session-side", "peer_name": "ghost", "content": "side bank note",
             "token_count": 3, "seq_in_session": 1, "h_metadata": None, "internal_metadata": None,
             "created_at": at(14), "role": None, "in_reply_to": None, "read": None, "read_at": None},
        ],
        "memories": [
            _memory("m_muigqmxf_qchtyc", "forgot-keys", "ลืมกุญแจไว้ที่บ้าน ต้องวางไว้ข้างประตู", "note", 20,
                    embedding=VECTOR, sync_state="synced", last_sync_at=at(21), sync_attempts=1,
                    superseded_by="m_muigr0aa_second", superseded_at=at(40), is_active=False,
                    internal_metadata='{"source":"v3-import"}'),
            _memory("m_muigr0aa_second", "keys-by-the-door", "Keys live on the hook by the door now.",
                    "learning", 30, h_metadata='{"visible":true}'),
            _memory("m_muigr1bb_retro", "retro-2026-09-19", "Retro: LanceDB timestamps are microseconds.",
                    "retro", 31, subject_peer_name="neo", session_name="session-alpha",
                    valid_from=at(0), valid_to=at(600)),
            _memory("m_muigr2cc_decide", "decision-log", "บันทึกการตัดสินใจ: ใช้ ngram สามตัวอักษร",
                    "Decision Log", 32, is_active=False),
            # SUB-MILLISECOND created_at: rejected, and its tag row with it.
            _memory("m_muigr3dd_subms", "sub-ms", "written with a microsecond clock", "note", 33,
                    created_at=SUB_MS),
            _memory("m_muigr4ee_old", "old-conclusion", "The old conclusion.", "conclusion", 34,
                    superseded_by="m_muigr5ff_new", superseded_at=at(50), is_active=False),
            _memory("m_muigr5ff_new", "new-conclusion", "The new conclusion, distilled from a trace.",
                    "conclusion", 35),
            {**_memory("m_side000_correct", "side-correction", "side bank correction", "correction", 36),
             "workspace_name": SIDE, "peer_name": "ghost"},
            # R11: not reserved, so it becomes `note`. It is too long to ALSO be
            # a tag term (256-byte name bound), so the memory still migrates
            # and the missing tag is one pointer record.
            _memory("m_muigr6gg_longtype", "stuffed-type", "a type field someone filled with prose",
                    LONG_TYPE, 37),
            # superseded_by with NO supersede_log row: one event is synthesized.
            {**_memory("m_side001_old", "side-old-plan", "Old plan for the side bank.", "learning", 38,
                       superseded_by="m_side002_new", superseded_at=at(60), is_active=False),
             "workspace_name": SIDE, "peer_name": "ghost"},
            {**_memory("m_side002_new", "side-new-plan", "New plan for the side bank.", "learning", 39),
             "workspace_name": SIDE, "peer_name": "ghost"},
        ],
        "vocabularies": [
            {"id": "vocab-topic", "name": "topic", "workspace_name": LAB, "label": "Topic",
             "description": None, "kind": "tags", "term_policy": "open", "h_metadata": None,
             "internal_metadata": None, "created_at": at(5)},
            # Collides with the reserved `type` vocabulary the target seeds: rejected.
            {"id": "vocab-legacy-type", "name": "type", "workspace_name": LAB, "label": "Type",
             "description": None, "kind": "categories", "term_policy": "open", "h_metadata": None,
             "internal_metadata": None, "created_at": at(5)},
            {"id": "vocab-project", "name": "project", "workspace_name": SIDE, "label": "Project",
             "description": None, "kind": "categories", "term_policy": "sealed", "h_metadata": None,
             "internal_metadata": None, "created_at": at(5)},
            # Over the kernel's 256-byte name bound: rejected, never written.
            # 90 Thai characters are 270 UTF-8 bytes, so a CHARACTER count
            # would let it through.
            {"id": "vocab-toolong", "name": "ข" * 90, "workspace_name": LAB, "label": "Too long",
             "description": None, "kind": "tags", "term_policy": "open", "h_metadata": None,
             "internal_metadata": None, "created_at": at(5)},
        ],
        "terms": [
            {"id": "term-oracle", "vocabulary_id": "vocab-topic", "name": "oracle", "description": None,
             "parent_id": None, "weight": 1.0, "h_metadata": None, "created_at": at(6)},
            {"id": "term-thai", "vocabulary_id": "vocab-topic", "name": "ภาษาไทย", "description": None,
             "parent_id": None, "weight": 2.0, "h_metadata": None, "created_at": at(6)},
            # Its vocabulary never existed: rejected as a record, never a KeyError.
            {"id": "term-orphan", "vocabulary_id": "vocab-missing", "name": "orphan", "description": None,
             "parent_id": None, "weight": 0.0, "h_metadata": None, "created_at": at(6)},
            # Its vocabulary was rejected (reserved-name clash): unresolved.
            {"id": "term-in-clash", "vocabulary_id": "vocab-legacy-type", "name": "decision",
             "description": None, "parent_id": None, "weight": 0.0, "h_metadata": None, "created_at": at(6)},
            {"id": "term-side", "vocabulary_id": "vocab-project", "name": "v4", "description": None,
             "parent_id": None, "weight": 0.0, "h_metadata": None, "created_at": at(6)},
            # A legacy PARENT inside a vocabulary R17 backfills as flat: the
            # kernel treats a stored parent there as corruption, so it is dropped.
            {"id": "term-keys", "vocabulary_id": "vocab-topic", "name": "keys", "description": None,
             "parent_id": "term-oracle", "weight": 1.5, "h_metadata": None, "created_at": at(7)},
            # Over the kernel's 256-byte name limit: rejected, never written.
            {"id": "term-toolong", "vocabulary_id": "vocab-topic", "name": "ก" * 90, "description": None,
             "parent_id": None, "weight": 0.0, "h_metadata": None, "created_at": at(7)},
        ],
        "memory_terms": [
            {"memory_id": "m_muigqmxf_qchtyc", "term_id": "term-oracle"},
            {"memory_id": "m_muigqmxf_qchtyc", "term_id": "term-thai"},
            {"memory_id": "m_muigr0aa_second", "term_id": "term-oracle"},
            {"memory_id": "m_muigr1bb_retro", "term_id": "term-orphan"},     # term rejected
            {"memory_id": "m_muigr3dd_subms", "term_id": "term-oracle"},     # memory rejected
            {"memory_id": "m_does_not_exist", "term_id": "term-oracle"},     # memory missing
            {"memory_id": "m_side000_correct", "term_id": "term-side"},
            {"memory_id": "m_muigr0aa_second", "term_id": "term-keys"},      # parent dropped, tag kept
        ],
        "supersede_log": [
            {"id": 1, "workspace_name": LAB, "old_id": "m_muigqmxf_qchtyc", "old_title": "forgot-keys",
             "old_type": "note", "old_source": None, "new_id": "m_muigr0aa_second",
             "new_title": "keys-by-the-door", "new_source": None, "reason": "moved the keys",
             "peer_name": "nat", "superseded_at": at(40), "h_metadata": None},
            # reason NULL: R17 backfills "legacy: reason not recorded" and counts it.
            {"id": 2, "workspace_name": LAB, "old_id": "m_muigr4ee_old", "old_title": "old-conclusion",
             "old_type": "conclusion", "old_source": None, "new_id": "m_muigr5ff_new",
             "new_title": "new-conclusion", "new_source": None, "reason": None, "peer_name": None,
             "superseded_at": at(50), "h_metadata": None},
            # Retirement with no successor.
            {"id": 3, "workspace_name": LAB, "old_id": "m_muigr2cc_decide", "old_title": "decision-log",
             "old_type": "Decision Log", "old_source": None, "new_id": None, "new_title": None,
             "new_source": None, "reason": "superseded by the ngram ruling", "peer_name": "nat",
             "superseded_at": at(55), "h_metadata": None},
            # Old memory never existed in this dataset: unresolved.
            {"id": 4, "workspace_name": LAB, "old_id": "m_gone_forever", "old_title": "gone",
             "old_type": "note", "old_source": None, "new_id": None, "new_title": None,
             "new_source": None, "reason": None, "peer_name": None, "superseded_at": at(56),
             "h_metadata": None},
        ],
        "traces": [
            {"id": "trace-001", "name": "0900_keys-hunt", "workspace_name": LAB,
             "session_name": "session-alpha", "peer_name": "nat", "query": "where are the keys",
             "mode": "deep", "session_id": "ext-session-jsonl", "session_from_ts": ms(9),
             "session_to_ts": ms(19), "friction_score": 0.5, "confidence": "high", "parent_id": None,
             "prev_id": None, "depth": 0, "status": "distilled", "distilled_to": "m_muigr5ff_new",
             "distilled_at": ms(36), "h_metadata": None, "internal_metadata": None,
             "created_at": ms(9), "updated_at": ms(36)},
            {"id": "trace-002", "name": "0910_keys-followup", "workspace_name": LAB,
             "session_name": None, "peer_name": None, "query": "follow up", "mode": None,
             "session_id": None, "session_from_ts": None, "session_to_ts": None,
             "friction_score": None, "confidence": None, "parent_id": "trace-001", "prev_id": None,
             "depth": 1, "status": "distilled", "distilled_to": "m_vanished", "distilled_at": ms(37),
             "h_metadata": None, "internal_metadata": None, "created_at": ms(10), "updated_at": ms(37)},
            # status raw: R17 (corrected 22:00) maps it to the kernel's `open`.
            {"id": "trace-003", "name": "0920_raw-open", "workspace_name": LAB,
             "session_name": None, "peer_name": "nat", "query": "is the drawer checked", "mode": None,
             "session_id": None, "session_from_ts": None, "session_to_ts": None,
             "friction_score": None, "confidence": None, "parent_id": None, "prev_id": None,
             "depth": 0, "status": "raw", "distilled_to": None, "distilled_at": None,
             "h_metadata": None, "internal_metadata": None, "created_at": ms(20), "updated_at": ms(20)},
        ],
        "trace_hits": [
            {"trace_id": "trace-001", "kind": "file", "ref": "src/db.ts:24-26", "line_start": 24,
             "line_end": 26, "note": "the table-missing error", "position": 0},
            # Kind INSIDE TARGET_KINDS: unresolved, no structured target invented.
            {"trace_id": "trace-003", "kind": "url", "ref": "https://example.com/keys", "line_start": None,
             "line_end": None, "note": None, "position": 0},
        ],
        "mcp_calls": [
            {"id": "c_mfq1_abc123", "workspace_name": LAB, "session_name": "session-alpha",
             "peer_name": None, "tool": "recall", "status": "ok", "duration_ms": 12,
             "h_metadata": None, "internal_metadata": None, "created_at": ms(15)},
            {"id": "c_mfq2_def456", "workspace_name": SIDE, "session_name": None, "peer_name": None,
             "tool": "remember", "status": "error", "duration_ms": 3, "h_metadata": None,
             "internal_metadata": None, "created_at": ms(16)},
        ],
        "connections": [
            {"id": "mcp:principal-01", "workspace_name": LAB, "method": "mcp",
             "principal": "principal-01", "label": "claude", "user_agent": None, "remote_ip": None,
             "first_seen": at(15), "last_seen": at(16), "requests": 2, "tool_calls": 2,
             "last_tool": "recall"},
        ],
        "read_cursors": [
            {"peer_name": "nat", "session_name": "session-alpha", "last_read_message_id": "msg-002",
             "last_read_at": at(17)},
        ],
    }


def build_legacy_fixture(source_root: Path) -> dict[str, Any]:
    """Write the 15 legacy tables into *source_root*. Returns a JSON-able summary."""

    source_root.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(source_root))
    rows = legacy_rows()
    for name, model in TABLES.items():
        table = db.create_table(name, schema=model)
        if rows[name]:
            table.add([model(**row) for row in rows[name]])
    return {
        "source_root": str(source_root.resolve()),
        "workspaces": [LAB, SIDE],
        "counts": {name: len(rows[name]) for name in TABLES},
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: export_legacy_fixture.py <empty-dir>")
    print(json.dumps(build_legacy_fixture(Path(sys.argv[1]))))
