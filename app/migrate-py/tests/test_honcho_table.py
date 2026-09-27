"""Issue #8, table level: v4 target-19 tier-1 rows INSERTed straight into a
stock Honcho v3.2.0 Postgres. Ruling R15 (2026-09-27 table-level update).

`TestLiveRoundTrip` (test_honcho_roundtrip.py) measures the REST interchange.
SPEC §15.2 invariant 1 claims more: that the tier-1 TABLES are byte-compatible,
so a bank exports as a plain table dump. This module measures that claim.

  * The offline tests pin the column map (`table_map`) against v4's own
    target-19 models and against the Honcho columns captured from the live
    database, and prove the SQL generator (`table_sql`) applies exactly the
    conversions the map documents and refuses values the Honcho table would
    reject.
  * `TestLiveTableRoundTrip` runs only when the same
    `HONCHO_ROUNDTRIP_LIVE_BASE_URL` gate is set, plus the compose project the
    harness (app/just/honcho-live.sh) stood up. It INSERTs through psql
    inside the database container, reads back through REST and SQL, and
    asserts the measured per-field outcome equals the documented one.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from arra_migrate.honcho_roundtrip.dump import dump_tier1
from arra_migrate.honcho_roundtrip.pin import NotALoopbackTargetError, require_loopback_url
from arra_migrate.honcho_roundtrip.table_map import (
    COLUMN_VERDICTS,
    EXPECTED_OUTCOMES,
    HONCHO_V3_2_0_COLUMNS,
    TIER1_TABLES,
    VERDICT_INDEX,
)
from arra_migrate.honcho_roundtrip.table_measure import measure_table_round_trip, read_rows_sql
from arra_migrate.honcho_roundtrip.table_sql import IncompatibleValueError, bundle_to_honcho_sql
from arra_migrate.honcho_roundtrip.target import HttpHonchoTarget
from arra_migrate.target_v1 import core as target19

sys.path.insert(0, str(Path(__file__).resolve().parent))
from honcho_table_bank import TABLE_WORKSPACE_NAME as WORKSPACE_NAME, build_target19_bank

V4_MODELS = {
    "workspaces": target19.Workspace,
    "peers": target19.Peer,
    "sessions": target19.Session,
    "session_peers": target19.SessionPeer,
    "messages": target19.Message,
}


class ColumnMapCoversBothSchemasTests(unittest.TestCase):
    """Every v4 column and every measured Honcho column has exactly one verdict."""

    def test_every_v4_target19_tier1_column_has_one_verdict(self) -> None:
        for table in TIER1_TABLES:
            v4_cols = [f.name for f in V4_MODELS[table].to_arrow_schema()]
            mapped = [v.v4_column for v in COLUMN_VERDICTS if v.table == table and v.v4_column is not None]
            self.assertEqual(sorted(mapped), sorted(v4_cols), table)

    def test_every_honcho_column_is_accounted_for(self) -> None:
        for table in TIER1_TABLES:
            honcho_cols = [c.name for c in HONCHO_V3_2_0_COLUMNS[table]]
            mapped = [v.honcho_column for v in COLUMN_VERDICTS if v.table == table and v.honcho_column is not None]
            self.assertEqual(sorted(mapped), sorted(honcho_cols), table)

    def test_verdicts_are_one_of_three_and_carry_their_reason(self) -> None:
        for v in COLUMN_VERDICTS:
            self.assertIn(v.verdict, {"exact", "convertible", "incompatible"}, v)
            if v.verdict != "exact":
                self.assertTrue(v.note.strip(), f"{v.table}.{v.v4_column} needs its conversion or reason")

    def test_the_metadata_column_is_named_differently(self) -> None:
        # A measured fact the historical claim missed: v4 stores `h_metadata`
        # (the SQLAlchemy ATTRIBUTE name), Honcho's SQL column is `metadata`.
        for table in ("workspaces", "peers", "sessions", "messages"):
            (v,) = [v for v in COLUMN_VERDICTS if v.table == table and v.v4_column == "h_metadata"]
            self.assertEqual((v.honcho_column, v.verdict), ("metadata", "convertible"))

    def test_every_expected_outcome_names_a_mapped_v4_column(self) -> None:
        mapped = {(v.table, v.v4_column) for v in COLUMN_VERDICTS if v.v4_column is not None}
        self.assertEqual(set(EXPECTED_OUTCOMES), mapped)

    def test_convertible_means_table_sql_applies_a_conversion(self) -> None:
        # Fix round: workspaces.id was "convertible" while table_sql refuses
        # it -- no id map exists. Each verdict must name what table_sql does.
        converts = {"ts", "json", "int32", "identity"}
        for v in COLUMN_VERDICTS:
            label = f"{v.table}.{v.v4_column}"
            if v.verdict == "convertible":
                self.assertTrue(v.kind in converts or v.v4_column != v.honcho_column, label)
            elif v.verdict == "exact":
                self.assertEqual((v.v4_column, v.kind in converts), (v.honcho_column, False), label)
        (ws_id,) = [v for v in COLUMN_VERDICTS if (v.table, v.v4_column) == ("workspaces", "id")]
        self.assertEqual(ws_id.verdict, "incompatible")
        self.assertTrue(ws_id.note.startswith("Exact if nanoid21, otherwise incompatible."))


REPO = Path(__file__).resolve().parents[3]


def _doc_rows(text: str) -> dict[tuple[str, str], tuple[str, str, str]]:
    rows: dict[tuple[str, str], tuple[str, str, str]] = {}
    table = ""
    for line in text.splitlines():
        if line.startswith("### "):
            table = line[4:].strip()
        elif table in TIER1_TABLES and line.startswith("| `"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            rows[(table, cells[0].split("`")[1])] = (cells[2], cells[4], cells[5])
    return rows


class DiffDocMatchesTheMapTests(unittest.TestCase):
    """HONCHO-TABLE-DIFF.md and R15 are what other agents quote. Fix round:
    they said 11 lost columns (10) and 13 timestamp columns (6)."""

    def setUp(self) -> None:
        self.doc = (REPO / "docs" / "overnight" / "HONCHO-TABLE-DIFF.md").read_text(encoding="utf-8")
        self.decisions = (REPO / "docs" / "overnight" / "DECISIONS.md").read_text(encoding="utf-8")
        self.count = {kind: sum(1 for v in COLUMN_VERDICTS if v.kind == kind and v.v4_column) for kind in ("drop", "ts", "json")}
        self.count["ts"] -= sum(1 for v in COLUMN_VERDICTS if v.kind == "ts" and v.honcho_column is None)

    def test_every_per_column_row_carries_the_map_verdict_and_measured_outcome(self) -> None:
        rows = _doc_rows(self.doc)
        self.assertEqual(set(rows), set(VERDICT_INDEX))
        for key, (verdict, rest, table) in rows.items():
            self.assertEqual(verdict, VERDICT_INDEX[key].verdict, key)
            self.assertEqual({"rest": rest, "table": table}, EXPECTED_OUTCOMES[key], key)

    def test_headline_counts_are_the_map_counts(self) -> None:
        self.assertEqual(self.count, {"drop": 10, "ts": 6, "json": 13})
        lost = re.findall(r"\b(\d+)\s+v4\s+columns\s+have\s+no\s+Honcho\s+column", self.doc)
        self.assertGreaterEqual(len(lost), 2, "the conclusion and the by-field summary both state it")
        self.assertEqual({int(n) for n in lost}, {self.count["drop"]})
        self.assertEqual({int(n) for n in re.findall(r"\b(\d+)\s+timestamp\s+columns", self.doc)}, {self.count["ts"]})
        self.assertEqual({int(n) for n in re.findall(r"\b(\d+)\s+JSON\s+columns", self.doc)}, {self.count["json"]})
        r15 = self.decisions.split("## R15", 1)[1].split("\n## ", 1)[0]
        self.assertEqual({int(n) for n in re.findall(r"\b(\d+)\s+v4-only\s+columns", r15)}, {self.count["drop"]})
        self.assertNotRegex(self.doc + r15, r"\b11\s+(?:v4|incompatible)")


class Target19BankTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-table-bank-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def test_bank_is_a_real_target19_dataset_that_dumps_back(self) -> None:
        written = build_target19_bank(self.root)
        dumped = dump_tier1(self.root, WORKSPACE_NAME)
        self.assertEqual(len(dumped.messages), len(written.messages))
        self.assertIn("ingested_at", dumped.messages[0])
        self.assertIn("mission", dumped.workspaces[0])
        for m in dumped.messages:
            self.assertEqual(len(m["public_id"]), 21)


class BundleToHonchoSqlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="arra-honcho-table-sql-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        build_target19_bank(self.root)
        self.bundle = dump_tier1(self.root, WORKSPACE_NAME)

    def test_sql_targets_only_stock_honcho_columns(self) -> None:
        sql = bundle_to_honcho_sql(self.bundle)
        self.assertNotIn("h_metadata", sql)
        for dropped in ("mission", "role", "in_reply_to", "read_at", "source_namespace", "ingested_at"):
            self.assertNotIn(f'"{dropped}"', sql)
        self.assertIn('"metadata"', sql)
        self.assertTrue(sql.startswith("BEGIN;"))
        self.assertIn("setval(pg_get_serial_sequence('messages', 'id')", sql)

    def test_null_json_text_becomes_the_empty_jsonb_object(self) -> None:
        sql = bundle_to_honcho_sql(self.bundle)
        self.assertIn("'{}'::jsonb", sql)
        self.assertNotIn("NULL::jsonb", sql)

    def test_naive_v4_timestamp_is_written_as_an_explicit_utc_instant(self) -> None:
        # dump_tier1 already returns UTC-aware values, so feed the naive
        # timestamp[us] value v4 stores directly (fix round: the old test never did).
        self.bundle.workspaces[0]["created_at"] = datetime(2026, 9, 26, 21, 0, 0, 250001)
        self.assertIsNone(self.bundle.workspaces[0]["created_at"].tzinfo)
        sql = bundle_to_honcho_sql(self.bundle)
        self.assertIn("'2026-09-26T21:00:00.250001+00:00'::timestamptz", sql)

    def test_an_aware_timestamp_in_another_zone_is_written_as_the_same_utc_instant(self) -> None:
        bangkok = timezone(timedelta(hours=7))
        self.bundle.workspaces[0]["created_at"] = datetime(2026, 9, 27, 4, 0, 0, 7, tzinfo=bangkok)
        sql = bundle_to_honcho_sql(self.bundle)
        self.assertIn("'2026-09-26T21:00:00.000007+00:00'::timestamptz", sql)

    def test_quotes_are_escaped_not_interpolated(self) -> None:
        self.bundle.messages[0]["content"] = "it's'); DROP TABLE messages; --"
        sql = bundle_to_honcho_sql(self.bundle)
        self.assertIn("'it''s''); DROP TABLE messages; --'", sql)

    def test_refuses_an_id_the_honcho_check_constraint_would_reject(self) -> None:
        # Honcho: CHECK (length(id) = 21) and id ~ '^[A-Za-z0-9_-]+$'. v4's own
        # dev seed uses `ws_default_devseed` (18 chars) for workspaces.id.
        self.bundle.workspaces[0]["id"] = "ws_default_devseed"
        with self.assertRaises(IncompatibleValueError) as cm:
            bundle_to_honcho_sql(self.bundle)
        self.assertIn("workspaces.id", str(cm.exception))

    def test_refuses_a_nul_character_postgres_text_cannot_store(self) -> None:
        self.bundle.messages[0]["content"] = "before\x00after"
        with self.assertRaises(IncompatibleValueError):
            bundle_to_honcho_sql(self.bundle)

    def test_refuses_a_token_count_outside_int32(self) -> None:
        self.bundle.messages[0]["token_count"] = 2**31
        with self.assertRaises(IncompatibleValueError) as cm:
            bundle_to_honcho_sql(self.bundle)
        self.assertIn("token_count", str(cm.exception))

    def test_refuses_a_name_over_honcho_512_char_check(self) -> None:
        self.bundle.sessions[0]["name"] = "s" * 512
        for m in self.bundle.messages + self.bundle.session_peers:
            if m["session_name"] == "session-one":
                m["session_name"] = "s" * 512
        bundle_to_honcho_sql(self.bundle)  # 512 is inside the CHECK
        self.bundle.peers[0]["name"] = "p" * 513
        with self.assertRaises(IncompatibleValueError) as cm:
            bundle_to_honcho_sql(self.bundle)
        self.assertIn("peers.name: 513 chars", str(cm.exception))

    def test_refuses_json_text_that_is_not_json(self) -> None:
        self.bundle.peers[0]["configuration"] = '{"observe_me": true'
        with self.assertRaises(IncompatibleValueError) as cm:
            bundle_to_honcho_sql(self.bundle)
        self.assertIn("peers.configuration: not JSON text", str(cm.exception))

    def test_refuses_a_json_number_python_reads_as_non_finite(self) -> None:
        # Python's json reads 1e400 as inf and accepts NaN/Infinity; jsonb
        # keeps 1e400 as an exact numeric (read back: a 401-digit integer --
        # measured live by the verifier) and rejects NaN/Infinity. Neither is
        # a value that survives, so the generator refuses them.
        for text in ('{"g": 1e400}', '{"g": -1e400}', '{"g": NaN}', '{"g": Infinity}', "[-Infinity]"):
            self.bundle.messages[0]["h_metadata"] = text
            with self.assertRaises(IncompatibleValueError, msg=text) as cm:
                bundle_to_honcho_sql(self.bundle)
            self.assertIn("messages.h_metadata", str(cm.exception))
        self.bundle.messages[0]["h_metadata"] = '{"g": 1e300, "n": 123456789012345678901234567890}'
        self.assertIn("'{\"g\": 1e300, \"n\": 123456789012345678901234567890}'::jsonb", bundle_to_honcho_sql(self.bundle))

    def test_refuses_content_over_honcho_65535_char_check(self) -> None:
        self.bundle.messages[0]["content"] = "x" * 65536
        with self.assertRaises(IncompatibleValueError):
            bundle_to_honcho_sql(self.bundle)

    def test_refuses_json_text_with_an_escaped_u0000(self) -> None:
        # Accept round, S7: nothing offline exercised table_sql.py:108 (the
        # jsonb U+0000 refusal), so removing it left every test green. A raw
        # NUL never reaches here (json.loads itself rejects a literal control
        # character in a string), but a JSON text SPELLING \u0000 is valid
        # JSON and decodes to one -- jsonb cannot hold it either.
        self.bundle.messages[0]["h_metadata"] = '{"g": "before\\u0000after"}'
        with self.assertRaises(IncompatibleValueError) as cm:
            bundle_to_honcho_sql(self.bundle)
        self.assertIn("jsonb cannot store U+0000", str(cm.exception))

    def test_bool_renders_as_the_sql_word_not_1_or_0(self) -> None:
        # Accept round, S12: Postgres boolean columns accept 1/0 by implicit
        # cast, so only a literal check on the rendered text (not a live
        # read-back) catches a generator that writes 1/0 instead of TRUE/FALSE.
        self.bundle.sessions[0]["is_active"] = True
        self.bundle.sessions[1]["is_active"] = False
        sql = bundle_to_honcho_sql(self.bundle)
        inserts = [line for line in sql.splitlines() if line.startswith('INSERT INTO "sessions"')]
        self.assertEqual(len(inserts), 2)
        cols = inserts[0].split("(", 1)[1].split(")", 1)[0]
        is_active_index = [c.strip() for c in cols.split(",")].index('"is_active"')

        def _nth_value(line: str, index: int) -> str:
            values = line.split("VALUES (", 1)[1].rsplit(");", 1)[0]
            # No value up to and including is_active contains a comma (ids,
            # names and the bool literal are all comma-free), so a plain
            # split is exact for this prefix.
            return values.split(", ")[index]

        rendered = {_nth_value(line, is_active_index) for line in inserts}
        self.assertEqual(rendered, {"TRUE", "FALSE"})


def _compose_psql(compose_dir: str, project: str, sql: str) -> str:
    proc = subprocess.run(
        ["docker", "compose", "-p", project, "exec", "-T", "database",
         "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"],
        input=sql, capture_output=True, text=True, cwd=compose_dir, timeout=120, check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"psql rc={proc.returncode}: {proc.stderr.strip()}")
    return proc.stdout


class TestLiveTableRoundTrip(unittest.TestCase):
    """The live table-level leg. Same gate as `TestLiveRoundTrip`, plus the
    compose project the harness stood up (it never starts a container)."""

    def test_table_dump_inserted_into_stock_honcho_reads_back_as_documented(self) -> None:
        base_url = os.environ.get("HONCHO_ROUNDTRIP_LIVE_BASE_URL")
        compose_dir = os.environ.get("HONCHO_TABLE_LIVE_COMPOSE_DIR")
        project = os.environ.get("HONCHO_TABLE_LIVE_COMPOSE_PROJECT")
        if not base_url:
            self.skipTest("HONCHO_ROUNDTRIP_LIVE_BASE_URL not set -- table-level live leg UNEXECUTED; run app/just/honcho-live.sh")
        if not (compose_dir and project):
            self.skipTest("HONCHO_TABLE_LIVE_COMPOSE_DIR/_PROJECT not set -- no database container to INSERT into; run app/just/honcho-live.sh")
        try:
            require_loopback_url(base_url)
        except NotALoopbackTargetError as exc:
            self.fail(str(exc))

        root = Path(tempfile.mkdtemp(prefix="arra-honcho-table-live-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        build_target19_bank(root)
        bundle = dump_tier1(root, WORKSPACE_NAME)

        def psql(sql: str) -> str:
            return _compose_psql(compose_dir, project, sql)

        # 1. The measured Honcho schema is the one the doc and the map describe.
        live_columns = json.loads(psql(
            "select coalesce(json_agg(json_build_array(table_name, column_name, data_type, is_nullable, "
            "coalesce(column_default, '')) order by table_name, column_name), '[]') "
            "from information_schema.columns where table_schema = 'public' and table_name in "
            "('workspaces','peers','sessions','session_peers','messages');"
        ))
        pinned = sorted(
            [t, c.name, c.data_type, "YES" if c.nullable else "NO", c.default]
            for t in TIER1_TABLES for c in HONCHO_V3_2_0_COLUMNS[t]
        )
        self.assertEqual(sorted(live_columns), pinned)

        # 2. A verbatim v4 row (v4 column names) is rejected by stock Honcho.
        with self.assertRaises(AssertionError) as cm:
            psql(f"INSERT INTO workspaces (id, name, created_at, h_metadata) VALUES "
                 f"('{'a' * 21}', 'verbatim-probe', now(), NULL);")
        self.assertIn('column "h_metadata" of relation "workspaces" does not exist', str(cm.exception))

        # 2b. jsonb keeps the JSON value, not the JSON text bytes.
        self.assertEqual(psql("select '{\"b\": 1,  \"a\":2}'::jsonb::text;").strip(), '{"a": 2, "b": 1}')

        # 3. The converted dump goes in through plain SQL.
        psql(bundle_to_honcho_sql(bundle))

        # 4. Read back through Honcho's REST API and through SQL; diff vs input.
        target = HttpHonchoTarget(base_url)
        sql_rows = read_rows_sql(psql, WORKSPACE_NAME)
        report = measure_table_round_trip(bundle, target, sql_rows)
        print("\n" + report.render(), flush=True)
        self.assertEqual(report.problems, [], report.problems)
        self.assertEqual(report.outcomes, EXPECTED_OUTCOMES)
        # Accept round, finding 4: fact 10 (a departed session_peers member,
        # left_at set, is not listed by GET .../sessions/{id}/peers) was only
        # printed as a note, never asserted, against the real server.
        self.assertTrue(
            any("are NOT listed" in n for n in report.notes),
            f"fact 10 (departed member not listed over REST) was not observed live: {report.notes}",
        )

        # 5. Honcho keeps working on top of the imported rows: a REST write
        #    after the import gets the next identity id and seq, no collision.
        after = target.create_messages(WORKSPACE_NAME, "session-two", [{"peer_id": "nat", "content": "post-import write"}])
        self.assertEqual(len(after), 1)
        ids = psql(f"select id from messages where workspace_name = '{WORKSPACE_NAME}' order by id desc limit 1;").strip()
        self.assertGreater(int(ids), max(m["id"] for m in bundle.messages))

        # 6. A SECOND v4 bank (another dataset: own workspace, own nanoids, the
        #    same per-dataset messages.id 1..10) cannot go in unchanged:
        #    Honcho's messages.id is one identity for the whole database.
        root2 = Path(tempfile.mkdtemp(prefix="arra-honcho-table-live-2-"))
        self.addCleanup(shutil.rmtree, root2, ignore_errors=True)
        build_target19_bank(root2, workspace_name=WORKSPACE_NAME + "-second", id_seed="second:")
        second = dump_tier1(root2, WORKSPACE_NAME + "-second")
        with self.assertRaises(AssertionError) as cm2:
            psql(bundle_to_honcho_sql(second))
        self.assertIn('duplicate key value violates unique constraint "pk_messages"', str(cm2.exception))
        left = psql(f"select count(*) from workspaces where name = '{WORKSPACE_NAME}-second';").strip()
        self.assertEqual(left, "0", "the failed import must roll back as one transaction")


if __name__ == "__main__":
    unittest.main()
