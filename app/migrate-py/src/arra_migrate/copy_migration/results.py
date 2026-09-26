"""Turn the Bun worker's JSONL outcome lines into final report records.

The worker prints one JSON object per line on stdout:

  {"kind":"taxonomy",  "workspace", "step", "outcome", "code"?}
  {"kind":"memory",    "workspace", "legacy_id", "outcome", "node_id"?, "code"?, "path"?}
  {"kind":"lifecycle", "workspace", "legacy_key", "outcome", "code"?}
  {"kind":"projection","workspace", "legacy_id", "terms", "links", "chunks", "outcome", "code"?}
  {"kind":"readback",  "listed_nodes": {ws: n}, "heads_ok": n, "heads_failed": [...]}
  {"kind":"codec",     "target_dataset_ok": bool, "tables": {name: {"rows": n, "failures": n}}}
  {"kind":"done"}

A planned memory is ``migrated`` only if the kernel returned ``accepted`` or
``idempotent`` for it. A planned row with NO result line is rejected as
``worker_no_result`` -- silence is never counted as success.
"""

from __future__ import annotations

from typing import Any

from .state import CopyState

ACCEPTED = ("accepted", "idempotent")


def apply_worker_results(lines: list[dict[str, Any]], pending: dict[str, Any], state: CopyState) -> dict[str, Any]:
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for line in lines:
        by_kind.setdefault(str(line.get("kind")), []).append(line)

    memory = {line["legacy_id"]: line for line in by_kind.get("memory", [])}
    migrated: set[str] = set()
    for legacy_id, ws in pending["memories"].items():
        line = memory.get(legacy_id)
        if line is None:
            state.rejected("memories", legacy_id, ws, "worker_no_result")
        elif line["outcome"] in ACCEPTED:
            migrated.add(legacy_id)
            state.migrated("memories", legacy_id, ws, line.get("node_id"))
        else:
            state.rejected("memories", legacy_id, ws, line.get("code") or line["outcome"], line.get("path"),
                           detail=line.get("message"))

    for key, ws, memory_id in pending["memory_terms"]:
        if memory_id in migrated:
            state.migrated("memory_terms", key, ws)
        else:
            state.rejected("memory_terms", key, ws, "memory_not_published", "/memory_id")

    for trace_key, ws, memory_id in pending["distilled"]:
        state.pointer("traces.distilled_to", trace_key, ws, memory_id in migrated,
                      code="memory_not_published",
                      detail="derived_from trace link on the conclusion revision; distilled_at in internal_metadata")

    lifecycle = {line["legacy_key"]: line for line in by_kind.get("lifecycle", [])}
    accepted_events: set[str] = set()
    for key, (table, ws) in pending["events"].items():
        line = lifecycle.get(key)
        ok = line is not None and line["outcome"] in ACCEPTED
        if ok:
            accepted_events.add(key)
        if table == "supersede_log":
            if ok:
                state.migrated("supersede_log", key, ws)
            else:
                state.rejected("supersede_log", key, ws,
                               "worker_no_result" if line is None else (line.get("code") or line["outcome"]),
                               None if line is None else line.get("path"))
    for memory_id, ws, event_key in pending["superseded_by"]:
        state.pointer("memories.superseded_by", memory_id, ws, event_key in accepted_events,
                      code="event_not_written")

    projections = by_kind.get("projection", [])
    readback = (by_kind.get("readback") or [{}])[-1]
    codec = (by_kind.get("codec") or [{}])[-1]
    return {
        "listed_nodes": readback.get("listed_nodes", {}),
        "heads_ok": readback.get("heads_ok", 0),
        "heads_failed": readback.get("heads_failed", []),
        "target_dataset_ok": bool(codec.get("target_dataset_ok", False)),
        "codec_rows": {name: t.get("rows", 0) for name, t in codec.get("tables", {}).items()},
        "codec_failures": {name: t["failures"] for name, t in codec.get("tables", {}).items() if t.get("failures")},
        "codec_failure_examples": {name: t["first"] for name, t in codec.get("tables", {}).items() if t.get("first")},
        "projection_failures": [p for p in projections if p.get("outcome") != "ok"],
        "taxonomy": by_kind.get("taxonomy", []),
        "worker_completed": bool(by_kind.get("done")),
    }
