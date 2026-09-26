"""Orchestrate one copy migration: legacy-15 source -> NEW target-19 candidate.

    arra-migrate-copy --source DIR --candidate EMPTY_DIR --work NEW_DIR --intake-at 2026-09-26T14:00:00.000Z

    1  preflight          refuse remote roots, a non-empty candidate/work, nesting
    2  snapshot           sha256 the ORIGINAL source; copy it to <work>/source-copy
    3  writer_gate(candidate), held until step 7 ends:
    4    create           the 19 target tables, empty (Python owns the schema)
    5    direct copy      12 legacy tables that map 1:1, ids mapped, times checked
    6    knowledge plan   memories/memory_terms/supersede_log/distilled_to -> plan.json
    7    Bun worker       inherits the SAME held gate; publishes through the kernel,
                          reads every head back, runs every stored-row codec
         any failure in 4-7 drops every table this run created, still under the
         gate, and re-raises: no half-written candidate is left to mount
    8  confirm            re-hash the original source; schema, body and
                          cross-row taxonomy checks
    9  report             <work>/report.json, records.jsonl, id_map.jsonl

Operator-only. Nothing here is reachable over HTTP, MCP or ``app/cli.ts``, and
the production migrator (``arra_migrate.__main__``) never imports it. No
cutover: the candidate is a new directory nobody serves until an operator
points ``ARRA_KNOWLEDGE_DATASET_ROOT`` at it; the source stays authoritative.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import lancedb

from ..writer_gate import writer_gate
from .ids import IdMap
from .plan import NULL_REASON, build_knowledge_plan
from .report import (
    INTAKE_ASSUMPTION,
    RELEASE_EXCLUSIONS,
    REPORT_VERSION,
    MigrationReport,
)
from .results import apply_worker_results
from .snapshot import (
    CopyMigrationRefused,
    confirm_untouched,
    preflight,
    snapshot_source,
)
from .state import CopyState
from .tables import copy_direct_tables, create_target_tables, discard_candidate
from .timestamps import iso_ms, parse_intake
from .verify import body_mismatches, candidate_schema_problems, taxonomy_problems
from .worker import DEADLINE_SECONDS, CopyMigrationFailed, run_worker


def run_copy_migration(
    source: str | os.PathLike[str],
    candidate: str | os.PathLike[str],
    work: str | os.PathLike[str],
    *,
    intake_at: str,
    bun: str | None = None,
    worker_deadline_seconds: float = DEADLINE_SECONDS,
) -> dict[str, Any]:
    try:
        intake = parse_intake(intake_at)
    except ValueError as error:
        raise CopyMigrationRefused("invalid_intake_at", f"intake_at must be exact UTC milliseconds: {error}") from None
    src, cand, wrk = preflight(source, candidate, work)
    wrk.mkdir(parents=True, exist_ok=True)

    report = MigrationReport()
    state = CopyState(ids=IdMap(), report=report, intake_at=intake)
    snapshot = snapshot_source(src, wrk)
    source_db = lancedb.connect(snapshot["copy_root"])

    with writer_gate(cand) as gate_fd:
        candidate_db = lancedb.connect(str(cand))
        try:
            create_target_tables(candidate_db)
            copy_direct_tables(source_db, candidate_db, state)
            plan, pending = build_knowledge_plan(source_db, state, str(cand))
            plan_path = wrk / "plan.json"
            plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=1) + "\n", "utf-8")
            lines = run_worker(cand, gate_fd, plan_path, bun, worker_deadline_seconds)
            readback = apply_worker_results(lines, pending, state)
        except BaseException:
            discard_candidate(candidate_db)
            raise

    source_state = confirm_untouched(snapshot)
    migrated = {r.legacy_key for r in report.records() if r.table == "memories" and r.outcome == "migrated"}
    schema_problems = candidate_schema_problems(cand)
    body_problems = body_mismatches(cand, plan, migrated)
    taxonomy = taxonomy_problems(cand)
    tables = report.table_summary()
    conserved = report.conservation_ok()
    verified = (
        conserved and source_state["untouched"] and not schema_problems and not body_problems and not taxonomy
        and readback["worker_completed"] and readback["target_dataset_ok"] and not readback["codec_failures"]
        and readback["heads_ok"] == len(migrated) and not readback["heads_failed"]
        and not readback["projection_failures"]
    )
    document = {
        "version": REPORT_VERSION,
        "intake_at": iso_ms(intake),
        "assumptions": [INTAKE_ASSUMPTION],
        "source": source_state,
        "candidate": {"root": str(cand), "schema_problems": schema_problems, "body_problems": body_problems,
                      "taxonomy_problems": taxonomy},
        "tables": tables,
        "conservation_ok": conserved,
        "policies": {
            "r11_type": "exact reserved type term kept; else note + original string as a legacy_type tag term; "
                        "a string over the 256-byte term-name bound rejects that memory alone",
            "r17_vocabulary": "legacy vocabularies: cardinality many, required false, hierarchy flat; "
                              "flat keeps no parent, so every legacy terms.parent_id is dropped and recorded",
            "r17_null_reason": NULL_REASON,
            "trace_status_map": "raw->open (R17, corrected 22:00); distilled->complete and "
                                "retired->abandoned are an IMPLEMENTER extension, not ruled; "
                                "legacy value kept on each trace record",
            "node_ids": "R18 D1 legacy_node_id: base64url(sha256('arra-legacy-node/v1\\n'+ws+'\\n'+id))[0:21]",
            "trace_hits": "kind outside TARGET_KINDS rejected; inside it unresolved (no structured locator)",
            **dict(report.policies),
        },
        "readback": readback,
        "verified": verified,
        # The candidate may be internally verified; the RELEASE is not, while
        # inherited gates are excluded. This never flips on this run's account.
        "release_exclusions": [dict(e) for e in RELEASE_EXCLUSIONS],
        "release_ready": False,
        "cutover": "none: the source is untouched and remains the served dataset",
    }
    report.write(wrk, document, state.ids.entries())
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="arra-migrate-copy", description=__doc__.split("\n\n")[0])
    parser.add_argument("--source", required=True, help="legacy-15 dataset directory (read, never written)")
    parser.add_argument("--candidate", required=True, help="EXISTING EMPTY directory for the target-19 copy")
    parser.add_argument("--work", required=True, help="absent or empty directory for snapshot and report")
    parser.add_argument("--intake-at", required=True, help="frozen migration intake time, YYYY-MM-DDTHH:MM:SS.sssZ")
    parser.add_argument("--bun", default=None, help="bun executable (default: $ARRA_BUN or PATH)")
    parser.add_argument("--worker-deadline-seconds", type=float, default=DEADLINE_SECONDS,
                        help=f"hard cap on the Bun knowledge phase (default {DEADLINE_SECONDS:g})")
    args = parser.parse_args(argv)
    try:
        document = run_copy_migration(args.source, args.candidate, args.work, intake_at=args.intake_at,
                                      bun=args.bun, worker_deadline_seconds=args.worker_deadline_seconds)
    except CopyMigrationRefused as error:
        print(json.dumps({"refused": error.code, "message": str(error)}), file=sys.stderr)
        return 2
    except CopyMigrationFailed as error:
        print(json.dumps({"failed": str(error)}), file=sys.stderr)
        return 1
    summary = {k: document[k] for k in ("verified", "conservation_ok", "release_ready")}
    summary["source_untouched"] = document["source"]["untouched"]
    summary["report"] = str(Path(args.work).resolve() / "report.json")
    print(json.dumps(summary))
    return 0 if document["verified"] else 1
