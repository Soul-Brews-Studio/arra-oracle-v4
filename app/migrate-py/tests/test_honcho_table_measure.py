"""Issue #8, table level: the comparator must be able to FAIL.

Ruling R15 (2026-09-27 table-level update), fix round. The live
``TestLiveTableRoundTrip`` asserts ``problems == []`` and outcomes equal to
``EXPECTED_OUTCOMES`` -- a claim worth nothing if the comparator never
reports anything. An independent verifier disabled five comparisons at once
(timestamp, JSON, exact, message order, SQL row set) and every test stayed
green. This module closes that: a faithful offline stand-in for "stock Honcho
after the SQL import" measures as documented, and then ONE corruption per
comparison, on each read path, must be reported.

``_ImportedHoncho`` is written by hand from the Honcho v3.2.0 REST schemas
and Postgres ``json_agg`` output (timestamptz as ``+00:00`` text with trailing
zeros trimmed, jsonb as a JSON value) -- deliberately NOT from ``table_map``,
so a wrong entry in the map cannot make this fixture agree with it.
"""

from __future__ import annotations

import copy
import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from arra_migrate.honcho_roundtrip.dump import dump_tier1
from arra_migrate.honcho_roundtrip.table_map import EXPECTED_OUTCOMES
from arra_migrate.honcho_roundtrip.table_measure import TableReport, measure_table_round_trip

sys.path.insert(0, str(Path(__file__).resolve().parent))
from honcho_table_bank import TABLE_WORKSPACE_NAME as WORKSPACE_NAME, build_target19_bank


def _pg_ts(value: datetime | None) -> str | None:
    """How Postgres ``json_agg`` spells a timestamptz in a UTC session."""
    if value is None:
        return None
    text = value.astimezone(timezone.utc).isoformat(timespec="microseconds")
    head, frac_tz = text.split(".")
    frac = frac_tz[:6].rstrip("0")
    return f"{head}.{frac}+00:00" if frac else f"{head}+00:00"


def _api_ts(value: datetime) -> str:
    """How Honcho's pydantic response models spell it."""
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _jsonb(text: str | None) -> Any:
    return {} if text is None else json.loads(text)


class _ImportedHoncho:
    """REST reads of a stock Honcho whose tables hold the imported bank."""

    def __init__(self, sql: dict[str, list[dict[str, Any]]]) -> None:
        self.sql = sql

    def _entity(self, row: dict[str, Any]) -> dict[str, Any]:
        out = {"id": row["name"], "metadata": row["metadata"], "configuration": row["configuration"],
               "created_at": _api_ts(datetime.fromisoformat(row["created_at"]))}
        if "workspace_name" in row:
            out["workspace_id"] = row["workspace_name"]
        return out

    def get_workspace(self, workspace_id: str) -> dict[str, Any]:
        (row,) = [w for w in self.sql["workspaces"] if w["name"] == workspace_id]
        return self._entity(row)

    def list_peers(self, workspace_id: str) -> list[dict[str, Any]]:
        return [self._entity(p) for p in self.sql["peers"]]

    def list_sessions(self, workspace_id: str) -> list[dict[str, Any]]:
        return [dict(self._entity(s), is_active=s["is_active"]) for s in self.sql["sessions"]]

    def get_session_peers(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
        names = {m["peer_name"] for m in self.sql["session_peers"] if m["session_name"] == session_id and m["left_at"] is None}
        return [p for p in self.list_peers(workspace_id) if p["id"] in names]

    def list_messages(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
        rows = sorted((m for m in self.sql["messages"] if m["session_name"] == session_id), key=lambda m: m["seq_in_session"])
        return [
            {"id": m["public_id"], "content": m["content"], "peer_id": m["peer_name"], "session_id": m["session_name"],
             "workspace_id": m["workspace_name"], "metadata": m["metadata"], "token_count": m["token_count"],
             "created_at": _api_ts(datetime.fromisoformat(m["created_at"]))}
            for m in rows
        ]


def _imported_sql(bundle: Any) -> dict[str, list[dict[str, Any]]]:
    """The rows ``read_rows_sql`` gets back after a faithful import."""

    def entity(r: dict[str, Any], *extra: str) -> dict[str, Any]:
        out = {"id": r["id"], "name": r["name"], "created_at": _pg_ts(r["created_at"]),
               "metadata": _jsonb(r["h_metadata"]), "configuration": _jsonb(r["configuration"]),
               "internal_metadata": _jsonb(r["internal_metadata"])}
        out.update({k: r[k] for k in extra})
        return out

    return {
        "workspaces": [entity(r) for r in bundle.workspaces],
        "peers": [entity(r, "workspace_name") for r in bundle.peers],
        "sessions": [entity(r, "workspace_name", "is_active") for r in bundle.sessions],
        "session_peers": [
            {"workspace_name": r["workspace_name"], "session_name": r["session_name"], "peer_name": r["peer_name"],
             "configuration": _jsonb(r["configuration"]), "internal_metadata": _jsonb(r["internal_metadata"]),
             "joined_at": _pg_ts(r["joined_at"]), "left_at": _pg_ts(r["left_at"])}
            for r in bundle.session_peers
        ],
        "messages": [
            {"id": r["id"], "public_id": r["public_id"], "workspace_name": r["workspace_name"],
             "session_name": r["session_name"], "peer_name": r["peer_name"], "content": r["content"],
             "token_count": r["token_count"], "seq_in_session": r["seq_in_session"],
             "created_at": _pg_ts(r["created_at"]), "metadata": _jsonb(r["h_metadata"]),
             "internal_metadata": _jsonb(r["internal_metadata"])}
            for r in bundle.messages
        ],
    }


class MeasureTableRoundTripTests(unittest.TestCase):
    def setUp(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="arra-honcho-table-measure-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        build_target19_bank(root)
        self.bundle = dump_tier1(root, WORKSPACE_NAME)
        self.sql = _imported_sql(self.bundle)
        self.rest_sql = copy.deepcopy(self.sql)  # what the REST fake serves; corrupt it separately
        self.first = self.bundle.messages[0]["public_id"]

    def _measure(self, rest: _ImportedHoncho | None = None) -> TableReport:
        return measure_table_round_trip(self.bundle, rest or _ImportedHoncho(self.rest_sql), self.sql)

    def _row(self, rows: list[dict[str, Any]], **match: Any) -> dict[str, Any]:
        (row,) = [r for r in rows if all(r[k] == v for k, v in match.items())]
        return row

    def assert_mismatch(self, report: TableReport, table: str, col: str, path: str) -> None:
        self.assertEqual(report.outcomes[(table, col)][path], "mismatch", report.render())
        self.assertIn(f"{table}.{col}: {path} read-back differs from the input", report.notes)

    # -- the baseline: without it every "must report" below proves nothing --

    def test_faithful_import_measures_exactly_as_documented(self) -> None:
        report = self._measure()
        self.assertEqual(report.problems, [], report.render())
        self.assertEqual(report.outcomes, EXPECTED_OUTCOMES)
        self.assertFalse([n for n in report.notes if "differs" in n], report.notes)
        self.assertTrue(any("are NOT listed" in n for n in report.notes), report.notes)
        self.assertTrue(any("peers.h_metadata: 1 NULL value(s) came back as {}" in n for n in report.notes), report.notes)

    def test_json_key_order_and_spacing_are_not_a_mismatch(self) -> None:
        # jsonb keeps the value, not the text: "converted" is value equality.
        row = self._row(self.sql["workspaces"])
        row["configuration"] = json.loads(json.dumps(row["configuration"], sort_keys=True))
        self.assertEqual(self._measure().outcomes[("workspaces", "configuration")]["table"], "converted")

    # -- SQL read-back: one corruption per comparison --

    def test_sql_changed_text_is_a_mismatch(self) -> None:
        self._row(self.sql["messages"], public_id=self.first)["content"] += "X"
        report = self._measure()
        self.assert_mismatch(report, "messages", "content", "table")
        self.assertEqual(report.outcomes[("messages", "content")]["rest"], "exact")

    def test_sql_equal_value_of_another_type_is_a_mismatch(self) -> None:
        row = self._row(self.sql["messages"], public_id=self.first)
        row["token_count"] = str(row["token_count"])
        self.assert_mismatch(self._measure(), "messages", "token_count", "table")

    def test_sql_timestamp_one_microsecond_later_is_a_mismatch(self) -> None:
        row = self._row(self.sql["messages"], public_id=self.first)
        row["created_at"] = _pg_ts(datetime.fromisoformat(row["created_at"]) + timedelta(microseconds=1))
        self.assert_mismatch(self._measure(), "messages", "created_at", "table")

    def test_sql_null_timestamp_that_came_back_set_is_a_mismatch(self) -> None:
        row = next(r for r in self.sql["session_peers"] if r["left_at"] is None)
        row["left_at"] = row["joined_at"]
        self.assert_mismatch(self._measure(), "session_peers", "left_at", "table")

    def test_sql_changed_json_value_is_a_mismatch(self) -> None:
        row = next(r for r in self.sql["peers"] if r["metadata"])
        row["metadata"] = dict(row["metadata"], injected=True)
        self.assert_mismatch(self._measure(), "peers", "h_metadata", "table")

    def test_sql_null_json_that_did_not_become_an_empty_object_is_a_mismatch(self) -> None:
        name = next(r["name"] for r in self.bundle.peers if r["h_metadata"] is None)
        self._row(self.sql["peers"], name=name)["metadata"] = None
        self.assert_mismatch(self._measure(), "peers", "h_metadata", "table")

    def test_sql_missing_row_is_a_problem(self) -> None:
        self.sql["messages"] = [m for m in self.sql["messages"] if m["public_id"] != self.first]
        report = self._measure()
        self.assertTrue(any(p.startswith("messages: SQL rows") for p in report.problems), report.render())

    def test_sql_extra_row_is_a_problem(self) -> None:
        extra = copy.deepcopy(self.sql["peers"][0])
        extra["name"] = "not-in-the-bank"
        self.sql["peers"].append(extra)
        self.assertTrue(any(p.startswith("peers: SQL rows") for p in self._measure().problems))

    # -- REST read-back: one corruption per comparison --

    def test_rest_changed_text_is_a_mismatch(self) -> None:
        self._row(self.rest_sql["messages"], public_id=self.first)["content"] += "X"
        report = self._measure()
        self.assert_mismatch(report, "messages", "content", "rest")
        self.assertEqual(report.outcomes[("messages", "content")]["table"], "exact")

    def test_rest_equal_value_of_another_type_is_a_mismatch(self) -> None:
        row = self._row(self.rest_sql["messages"], public_id=self.first)
        row["token_count"] = str(row["token_count"])
        self.assert_mismatch(self._measure(), "messages", "token_count", "rest")

    def test_rest_timestamp_one_microsecond_later_is_a_mismatch(self) -> None:
        row = self._row(self.rest_sql["peers"], name="nat")
        row["created_at"] = _pg_ts(datetime.fromisoformat(row["created_at"]) + timedelta(microseconds=1))
        self.assert_mismatch(self._measure(), "peers", "created_at", "rest")

    def test_rest_changed_json_value_is_a_mismatch(self) -> None:
        row = self._row(self.rest_sql["sessions"], name="session-two")
        row["configuration"] = {"changed": 1}
        self.assert_mismatch(self._measure(), "sessions", "configuration", "rest")

    def test_rest_missing_message_is_a_problem(self) -> None:
        self.rest_sql["messages"] = [m for m in self.rest_sql["messages"] if m["public_id"] != self.first]
        self.assertTrue(any(p.startswith("messages: REST rows") for p in self._measure().problems))

    def test_rest_missing_active_member_is_a_problem(self) -> None:
        active = next(r for r in self.rest_sql["session_peers"] if r["left_at"] is None)
        active["left_at"] = active["joined_at"]  # REST now hides a member the input says is active
        self.assertTrue(any(p.startswith("session_peers: REST rows") for p in self._measure().problems))

    def test_rest_listing_a_departed_member_is_reported_not_hidden(self) -> None:
        for r in self.rest_sql["session_peers"]:
            r["left_at"] = None
        report = self._measure()
        self.assertTrue(any("ARE listed" in n for n in report.notes), report.notes)

    def test_rest_order_other_than_seq_in_session_is_a_problem(self) -> None:
        class Reversed(_ImportedHoncho):
            def list_messages(self, workspace_id: str, session_id: str) -> list[dict[str, Any]]:
                return super().list_messages(workspace_id, session_id)[::-1]

        report = self._measure(Reversed(self.rest_sql))
        order = [p for p in report.problems if p.startswith("messages order in")]
        self.assertEqual(len(order), 2, report.render())
        self.assertEqual(order, report.problems)


if __name__ == "__main__":
    unittest.main()
