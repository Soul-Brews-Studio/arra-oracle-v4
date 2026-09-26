"""The per-record migration report and its conservation check.

One record per SOURCE ROW, for all 15 legacy tables, memories and
memory_terms included:

    outcome   migrated | rejected | unresolved
    rows_in == migrated + rejected + unresolved      (per table, or not conserved)

``rejected`` means the row itself cannot be represented in the target (a
sub-millisecond time, a reserved-name clash, a kernel refusal). ``unresolved``
means the row points at something that did not migrate (an orphan term, a
supersede row whose memory is gone). Both stay in the SOURCE, which is never
modified, so nothing is lost -- it is reported and left where it was.

Pointer records (``<table>.<column>``, e.g. ``traces.distilled_to``) describe a
reference carried by a migrated row. They are listed with the records but are
NOT part of any table's conservation sum.

The inherited release gates are named EXCLUDED here, on every report, so a
green conservation line can never read as a release verdict (ruling R17).
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from ..models import TABLES as ACTIVE_TABLES

REPORT_VERSION = "arra-migrate-copy/v1"
ROW_OUTCOMES = ("migrated", "rejected", "unresolved")
POINTER_OUTCOMES = ("resolved", "unresolved")
INTAKE_ASSUMPTION = "ingested_at=migration_intake;original_ingestion_unknown"

#: docs/overnight/DECISIONS.md R15, R16, R17. Named on every report.
RELEASE_EXCLUSIONS = (
    {
        "issue": 7,
        "gate": "Thai/English recall quality: relevance judgments by someone other than the "
                "agent that wrote the queries (R16 phase B)",
        "status": "release_excluded",
        "evidence": "harness only; no quality number is published from an agent-authored corpus",
    },
    {
        "issue": 8,
        "gate": "stock Honcho v3.2.0 round-trip against a live container (R15)",
        "status": "release_excluded",
        "evidence": "container runtime not started; the shared white.local instance is ruled out",
    },
    {
        "issue": 10,
        "gate": "v3-defect regression quality half (inside-word recall quality depends on #7 judgments)",
        "status": "release_excluded",
        "evidence": "isolation/inside-word mechanics tested elsewhere; the quality half is not claimed",
    },
)


@dataclass(frozen=True)
class Record:
    table: str
    legacy_key: str
    workspace: str | None
    outcome: str
    code: str | None = None
    pointer: str | None = None
    target_id: str | None = None
    detail: str | None = None


class MigrationReport:
    """Collects records; renders the table summary and the final document."""

    def __init__(self) -> None:
        self._records: list[Record] = []
        self.rows_in: dict[str, int] = {}
        self.policies: Counter[str] = Counter()

    def add(self, table: str, legacy_key: object, workspace: str | None, outcome: str, *,
            code: str | None = None, pointer: str | None = None,
            target_id: str | None = None, detail: str | None = None) -> None:
        pointer_table = "." in table
        allowed = POINTER_OUTCOMES if pointer_table else ROW_OUTCOMES
        if outcome not in allowed:
            raise ValueError(f"{table}: outcome {outcome!r} not in {allowed}")
        self._records.append(Record(table, str(legacy_key), workspace, outcome, code, pointer, target_id, detail))

    def records(self) -> list[Record]:
        return list(self._records)

    def table_summary(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for name in ACTIVE_TABLES:
            counts = Counter(r.outcome for r in self._records if r.table == name)
            rows_in = self.rows_in.get(name, 0)
            summary = {"rows_in": rows_in, **{o: counts.get(o, 0) for o in ROW_OUTCOMES}}
            summary["conserved"] = rows_in == sum(summary[o] for o in ROW_OUTCOMES)
            out[name] = summary
        return out

    def conservation_ok(self) -> bool:
        return all(t["conserved"] for t in self.table_summary().values())

    def write(self, work: Path, document: dict[str, Any], id_entries: list[dict[str, Any]]) -> None:
        (work / "report.json").write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", "utf-8")
        with (work / "records.jsonl").open("w", encoding="utf-8") as handle:
            for record in self._records:
                handle.write(json.dumps(asdict(record), ensure_ascii=False) + "\n")
        with (work / "id_map.jsonl").open("w", encoding="utf-8") as handle:
            for entry in id_entries:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
