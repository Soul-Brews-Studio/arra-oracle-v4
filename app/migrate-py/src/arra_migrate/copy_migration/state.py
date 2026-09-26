"""What has migrated so far: the lookups every later table resolves against.

Built up in dependency order by the direct-table copy, then read by the
knowledge plan. A reference that is not in here did not migrate, and the row
carrying it is reported -- the lookup never raises (the old rehearsal's
``KeyError('vocab-missing')`` left a half-written target behind).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .ids import IdMap
from .report import MigrationReport


@dataclass
class CopyState:
    ids: IdMap
    report: MigrationReport
    intake_at: datetime
    workspaces: set[str] = field(default_factory=set)
    peers: set[tuple[str, str]] = field(default_factory=set)
    sessions: set[tuple[str, str]] = field(default_factory=set)
    #: legacy public_id -> target public_id, per workspace
    messages: dict[tuple[str, str], str] = field(default_factory=dict)
    #: legacy vocabulary id -> {workspace, id, name}
    vocabularies: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: legacy term id -> {workspace, id, name, vocabulary_id, vocabulary_name}
    terms: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: legacy trace id -> {workspace, id}
    traces: dict[str, dict[str, Any]] = field(default_factory=dict)

    def migrated(self, table: str, key: object, workspace: str | None, target_id: str | None = None,
                 detail: str | None = None) -> None:
        self.report.add(table, key, workspace, "migrated", target_id=target_id, detail=detail)

    def rejected(self, table: str, key: object, workspace: str | None, code: str,
                 pointer: str | None = None, detail: str | None = None) -> None:
        self.report.add(table, key, workspace, "rejected", code=code, pointer=pointer, detail=detail)

    def unresolved(self, table: str, key: object, workspace: str | None, code: str,
                   pointer: str | None = None, detail: str | None = None) -> None:
        self.report.add(table, key, workspace, "unresolved", code=code, pointer=pointer, detail=detail)

    def pointer(self, table: str, key: object, workspace: str | None, resolved: bool, *,
                code: str | None = None, detail: str | None = None) -> None:
        self.report.add(table, key, workspace, "resolved" if resolved else "unresolved",
                        code=None if resolved else code, detail=detail)
