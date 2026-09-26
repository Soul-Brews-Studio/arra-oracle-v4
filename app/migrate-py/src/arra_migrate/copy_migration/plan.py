"""The knowledge plan: legacy memories -> work orders for the Bun kernel worker.

Python decides POLICY and IDS; TypeScript builds and validates revision bytes
through ``publishRevision`` (Bun is the one canonicalizer). Nothing in here
computes a digest or canonical JSON.

Per memory (ruling R11 + R17, docs/overnight/DECISIONS.md):
  - node id / first revision id: deterministic from the legacy id (ids.py);
  - ``type``: an EXACT reserved term (note, conclusion, learning, discussion,
    correction) is kept; anything else becomes ``note`` and the original
    string becomes a term in the workspace's ``legacy_type`` tag vocabulary;
  - ``memory_terms`` rows become the revision's term snapshot, which the
    kernel projects into ``node_revision_terms``;
  - ``traces.distilled_to`` pointing here becomes a ``derived_from`` link to
    the trace (``locator_only``, ``captured_at`` NULL); ``distilled_at`` goes
    into ``internal_metadata``, never invented as ``captured_at``;
  - author/observer stay NULL; the legacy writer is kept as
    ``legacy_peer_name`` with ``attribution_unresolved: true``. No horizon is
    inferred;
  - legacy vectors are never reused: ``vector_disposition`` records why.

Per supersede row: a supersede or retire lifecycle event pinned to the
revisions above; a NULL reason becomes ``"legacy: reason not recorded"`` and
is counted.

Rows that cannot be planned are recorded here (rejected/unresolved). Rows that
are planned get their final record from ``results.py`` once the worker says
whether the kernel accepted them.
"""

from __future__ import annotations

import json
from typing import Any

from .ids import IdCollision
from .report import REPORT_VERSION
from .state import CopyState
from .tables import read_rows
from .taxonomy_tables import LEGACY_TYPE_VOCABULARY
from .timestamps import epoch_ms, first_sub_ms, iso_ms

Row = dict[str, Any]

PLAN_VERSION = "arra-migrate-copy/plan-v1"
RESERVED_TYPE_TERMS = ("note", "conclusion", "learning", "discussion", "correction")
HORIZON_TERMS = ("short_term", "long_term")
#: R17: the target requires a reason; the legacy log allowed NULL.
NULL_REASON = "legacy: reason not recorded"
OP = "arra-migrate-copy/v1"


def _text_time(value: Any) -> str | None:
    """A legacy time kept only as METADATA text: every microsecond preserved."""

    return None if value is None else value.isoformat(timespec="microseconds")


def _seed(state: CopyState, ws: str) -> dict[str, Any]:
    def vid(name: str) -> str:
        return state.ids.assign("vocabularies", ws, f"seed:{name}", derived_key=f"seed:{name}")

    def tid(vocab: str, name: str) -> str:
        return state.ids.assign("terms", ws, f"seed:{vocab}:{name}", derived_key=f"seed:{vocab}:{name}")

    return {
        "type": {"vocabulary_id": vid("type"), "terms": {t: tid("type", t) for t in RESERVED_TYPE_TERMS}},
        "memory_horizon": {"vocabulary_id": vid("memory_horizon"),
                           "terms": {t: tid("memory_horizon", t) for t in HORIZON_TERMS}},
    }


def _metadata(row: Row) -> dict[str, Any]:
    return {
        "migration": REPORT_VERSION,
        "legacy_id": row["id"],
        "legacy_peer_name": row["peer_name"],
        "attribution_unresolved": True,
        "legacy_type": row["type"],
        "legacy_sync_state": row["sync_state"],
        "legacy_sync_attempts": str(row["sync_attempts"]),
        "legacy_last_sync_at": _text_time(row["last_sync_at"]),
        "legacy_superseded_by": row["superseded_by"],
        "legacy_superseded_at": _text_time(row["superseded_at"]),
        "legacy_h_metadata_text": row["h_metadata"],
        "legacy_internal_metadata_text": row["internal_metadata"],
        # No per-row profile exists on legacy memories (memory.py), so a stored
        # vector's provenance is unknown and it is never reused.
        "vector_disposition": "rebuild_unknown_profile" if row["embedding"] is not None else "none",
        "legacy_distilled": [],
        "unresolved_references": {},
    }


def _h_metadata(text: str | None) -> str | None:
    if text is None:
        return None
    try:
        return text if isinstance(json.loads(text), dict) else None
    except ValueError:
        return None


def build_knowledge_plan(source_db: Any, state: CopyState, candidate_root: str) -> tuple[dict[str, Any], dict[str, Any]]:
    memories = sorted(read_rows(source_db, "memories"), key=lambda r: (r["created_at"], r["id"]))
    memory_terms = sorted(read_rows(source_db, "memory_terms"), key=lambda r: (r["memory_id"], r["term_id"]))
    log_rows = sorted(read_rows(source_db, "supersede_log"), key=lambda r: (r["superseded_at"], r["id"]))
    traces = sorted(read_rows(source_db, "traces"), key=lambda r: r["id"])
    for name, rows in (("memories", memories), ("memory_terms", memory_terms), ("supersede_log", log_rows)):
        state.report.rows_in[name] = len(rows)

    workspaces: dict[str, dict[str, Any]] = {}
    planned: dict[str, dict[str, Any]] = {}      # legacy memory id -> plan item
    source_ids = {row["id"] for row in memories}
    pending: dict[str, Any] = {"memories": {}, "memory_terms": [], "distilled": [], "events": {}, "superseded_by": []}

    def workspace(ws: str) -> dict[str, Any]:
        if ws not in workspaces:
            workspaces[ws] = {"workspace_name": ws, "seed": _seed(state, ws), "legacy_type_vocabulary": None,
                              "legacy_type_terms": [], "memories": [], "lifecycle": []}
        return workspaces[ws]

    for row in memories:
        ws, key = row["workspace_name"], row["id"]
        if ws not in state.workspaces:
            state.unresolved("memories", key, ws, "workspace_unresolved", "/workspace_name")
            continue
        bad = first_sub_ms(row, ("created_at", "valid_from", "valid_to"))
        if bad is not None:
            state.rejected("memories", key, ws, "sub_millisecond_timestamp", f"/{bad}",
                           detail=f"{row[bad].isoformat()} is not millisecond-exact; refusing to round")
            continue
        try:
            node_id = state.ids.assign("nodes", ws, key)
            revision_id = state.ids.assign("node_revisions", ws, key, derived_key=f"{key}#1")
        except IdCollision as error:
            state.rejected("memories", key, ws, "id_collision", "/id", detail=str(error))
            continue
        target = workspace(ws)
        meta = _metadata(row)
        tag = None
        if row["type"] in RESERVED_TYPE_TERMS:
            type_term = row["type"]
        else:
            type_term = "note"
            if row["type"]:
                tag = row["type"]
                if tag not in {t["name"] for t in target["legacy_type_terms"]}:
                    target["legacy_type_terms"].append({"term_id": state.ids.assign(
                        "terms", ws, f"r11:{LEGACY_TYPE_VOCABULARY}:{tag}",
                        derived_key=f"r11:{LEGACY_TYPE_VOCABULARY}:{tag}"), "name": tag})
            else:
                meta["unresolved_references"]["type"] = "empty legacy type: kept as note, no tag term"
        refs = {}
        for column, scope in (("subject_peer_name", state.peers), ("session_name", state.sessions)):
            value = row[column]
            refs[column] = value if value is None or (ws, value) in scope else None
            if value is not None and refs[column] is None:
                meta["unresolved_references"][column] = value
                state.pointer(f"memories.{column}", key, ws, False, code="reference_unresolved",
                              detail=f"legacy {column}={value!r} did not migrate; kept in internal_metadata")
        item = {
            "legacy_id": key, "node_id": node_id, "revision_id": revision_id,
            "operation_id": f"{OP}:memory:{key}", "created_at_ms": epoch_ms(row["created_at"]),
            "title": row["name"], "body": row["content"], "is_active": bool(row["is_active"]),
            "subject_peer_name": refs["subject_peer_name"], "session_name": refs["session_name"],
            "valid_from": iso_ms(row["valid_from"]), "valid_to": iso_ms(row["valid_to"]),
            "h_metadata": _h_metadata(row["h_metadata"]), "internal_metadata": meta,
            "type_term": type_term, "legacy_type_tag": tag, "terms": [], "links": [],
        }
        target["memories"].append(item)
        planned[key] = item
        pending["memories"][key] = ws

    for ws, target in workspaces.items():
        if target["legacy_type_terms"]:
            target["legacy_type_vocabulary"] = {"vocabulary_id": state.ids.assign(
                "vocabularies", ws, f"r11:{LEGACY_TYPE_VOCABULARY}", derived_key=f"r11:{LEGACY_TYPE_VOCABULARY}"),
                "name": LEGACY_TYPE_VOCABULARY}

    for row in memory_terms:
        key = f"{row['memory_id']}|{row['term_id']}"
        item = planned.get(row["memory_id"])
        term = state.terms.get(row["term_id"])
        if item is None:
            if row["memory_id"] in source_ids:
                state.rejected("memory_terms", key, None, "memory_not_migrated", "/memory_id")
            else:
                state.unresolved("memory_terms", key, None, "memory_unresolved", "/memory_id")
            continue
        ws = pending["memories"][row["memory_id"]]
        if term is None or term["workspace"] != ws:
            state.unresolved("memory_terms", key, ws, "term_unresolved", "/term_id",
                             detail=f"legacy term_id={row['term_id']!r} did not migrate into {ws!r}")
            continue
        if any(t["term_id"] == term["id"] for t in item["terms"]):
            state.rejected("memory_terms", key, ws, "duplicate_assignment", "/term_id")
            continue
        item["terms"].append({"term_id": term["id"], "vocabulary_id": term["vocabulary_id"],
                              "vocabulary_name": term["vocabulary_name"], "term_name": term["name"]})
        pending["memory_terms"].append((key, ws, row["memory_id"]))

    for row in traces:
        trace = state.traces.get(row["id"])
        if trace is None or row["distilled_to"] is None:
            continue
        ws = trace["workspace"]
        item = planned.get(row["distilled_to"])
        if item is None or pending["memories"][row["distilled_to"]] != ws:
            state.pointer("traces.distilled_to", row["id"], ws, False, code="memory_unresolved",
                          detail=f"legacy distilled_to={row['distilled_to']!r}, distilled_at={row['distilled_at']!r}")
            continue
        item["links"].append({"trace_id": trace["id"]})
        item["internal_metadata"]["legacy_distilled"].append({
            "trace_id": trace["id"], "legacy_trace_id": row["id"],
            "distilled_at_ms": None if row["distilled_at"] is None else str(row["distilled_at"]),
        })
        pending["distilled"].append((row["id"], ws, row["distilled_to"]))

    _plan_lifecycle(log_rows, memories, planned, pending, source_ids, state, workspace)
    plan = {
        "version": PLAN_VERSION,
        "candidate_root": candidate_root,
        "intake_at_ms": epoch_ms(state.intake_at),
        "workspaces": [workspaces[ws] for ws in sorted(workspaces)],
    }
    return plan, pending


def _plan_lifecycle(log_rows, memories, planned, pending, source_ids, state, workspace) -> None:
    events: list[dict[str, Any]] = []
    matched: dict[tuple[str, str, str], str] = {}
    null_reasons = sum(1 for row in log_rows if row["reason"] is None)
    state.report.policies["null_reason_rows_in"] = null_reasons
    state.report.policies["null_reason_backfilled"] = 0
    state.report.policies["missing_log_row_backfilled"] = 0

    def endpoint(legacy_id, ws, pointer):
        item = planned.get(legacy_id)
        if item is not None and pending["memories"][legacy_id] == ws:
            return item, None
        return None, ("rejected", f"{pointer[1:]}_not_migrated") if legacy_id in source_ids else ("unresolved", f"{pointer[1:]}_unresolved")

    for row in log_rows:
        ws, key = row["workspace_name"], str(row["id"])
        if ws not in state.workspaces:
            state.unresolved("supersede_log", key, ws, "workspace_unresolved", "/workspace_name")
            continue
        old, problem = endpoint(row["old_id"], ws, "/old_id")
        new = None
        if problem is None and row["new_id"] is not None:
            new, problem = endpoint(row["new_id"], ws, "/new_id")
            pointer = "/new_id"
        else:
            pointer = "/old_id"
        if problem is not None:
            getattr(state, problem[0])("supersede_log", key, ws, problem[1], pointer)
            continue
        if first_sub_ms(row, ("superseded_at",)) is not None:
            state.rejected("supersede_log", key, ws, "sub_millisecond_timestamp", "/superseded_at")
            continue
        reason = row["reason"]
        if reason is None:
            reason = NULL_REASON
            state.report.policies["null_reason_backfilled"] += 1
        matched[(ws, row["old_id"], row["new_id"] or "")] = key
        events.append(_event(key, ws, old, new, reason, row["peer_name"], epoch_ms(row["superseded_at"]),
                             "supersede_log"))

    for row in memories:
        item = planned.get(row["id"])
        if item is None or row["superseded_by"] is None:
            continue
        ws = pending["memories"][row["id"]]
        key = f"{row['id']}->{row['superseded_by']}"
        if (ws, row["id"], row["superseded_by"]) in matched:
            pending["superseded_by"].append((row["id"], ws, matched[(ws, row["id"], row["superseded_by"])]))
            continue
        new = planned.get(row["superseded_by"])
        at = row["superseded_at"]
        if new is None or pending["memories"][row["superseded_by"]] != ws or at is None or first_sub_ms(row, ("superseded_at",)):
            state.pointer("memories.superseded_by", row["id"], ws, False, code="successor_unresolved",
                          detail=f"legacy superseded_by={row['superseded_by']!r} with no migratable event")
            continue
        state.report.policies["missing_log_row_backfilled"] += 1
        events.append(_event(key, ws, item, new, NULL_REASON, None, epoch_ms(at), "memories.superseded_by"))
        pending["superseded_by"].append((row["id"], ws, key))

    for event in sorted(events, key=lambda e: (e["at_ms"], e["legacy_key"])):
        workspace(event["workspace"])["lifecycle"].append(event)
        pending["events"][event["legacy_key"]] = (event["table"], event["workspace"])


def _event(key, ws, old, new, reason, peer, at_ms, table) -> dict[str, Any]:
    return {
        "legacy_key": key, "table": table, "workspace": ws,
        "kind": "supersede" if new is not None else "retire",
        "node_legacy_id": old["legacy_id"], "node_id": old["node_id"],
        "expected_revision_id": old["revision_id"],
        "new_node_id": None if new is None else new["node_id"],
        "new_revision_id": None if new is None else new["revision_id"],
        "reason": reason, "peer_name": peer, "at_ms": at_ms,
        "operation_id": f"{OP}:{'supersede' if new is not None else 'retire'}:{key}",
    }
