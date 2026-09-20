from __future__ import annotations

import re
import unittest
from datetime import datetime, timedelta, timezone

from arra_migrate.contract_v1 import (
    canonical_message,
    format_int64,
    format_timestamp,
    message_digest,
    new_id,
    parse_int64,
    parse_timestamp,
    validate_id,
)


class IdContractTests(unittest.TestCase):
    def test_new_id_is_valid_unique_url_safe_text(self) -> None:
        values = [new_id() for _ in range(100)]

        self.assertEqual(len(values), len(set(values)))
        for value in values:
            self.assertRegex(value, re.compile(r"\A[A-Za-z0-9_-]{21}\Z"))
            self.assertIs(validate_id(value), value)

    def test_validate_id_rejects_wrong_type_length_and_alphabet(self) -> None:
        invalid = [None, b"a" * 21, "", "a" * 20, "a" * 22, "a" * 20 + "+", "é" * 21]

        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_id(value)  # type: ignore[arg-type]


class Int64ContractTests(unittest.TestCase):
    def test_int64_bounds_round_trip(self) -> None:
        cases = {
            "-9223372036854775808": -(2**63),
            "-1": -1,
            "0": 0,
            "1": 1,
            "9223372036854775807": 2**63 - 1,
        }

        for encoded, value in cases.items():
            with self.subTest(encoded=encoded):
                self.assertEqual(parse_int64(encoded), value)
                self.assertEqual(format_int64(value), encoded)

    def test_parse_int64_rejects_noncanonical_or_out_of_range_values(self) -> None:
        invalid = [
            None,
            0,
            "",
            "+1",
            "-0",
            "00",
            "01",
            "-01",
            " 1",
            "1 ",
            "1.0",
            "١",
            "9223372036854775808",
            "-9223372036854775809",
        ]

        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_int64(value)  # type: ignore[arg-type]

    def test_format_int64_rejects_bool_non_int_and_out_of_range_values(self) -> None:
        invalid = [True, False, 1.0, "1", None, 2**63, -(2**63) - 1]

        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                format_int64(value)  # type: ignore[arg-type]


class TimestampContractTests(unittest.TestCase):
    def test_parse_and_format_timestamp(self) -> None:
        cases = [
            "0001-01-01T00:00:00.000Z",
            "2024-02-29T23:59:59.123Z",
            "9999-12-31T23:59:59.999Z",
        ]

        for encoded in cases:
            with self.subTest(encoded=encoded):
                parsed = parse_timestamp(encoded)
                self.assertEqual(parsed.tzinfo, timezone.utc)
                self.assertEqual(format_timestamp(parsed), encoded)

    def test_parse_timestamp_rejects_noncanonical_and_invalid_values(self) -> None:
        invalid = [
            None,
            datetime.now(timezone.utc),
            "",
            "0000-01-01T00:00:00.000Z",
            "10000-01-01T00:00:00.000Z",
            "2023-02-29T00:00:00.000Z",
            "2024-13-01T00:00:00.000Z",
            "2024-01-32T00:00:00.000Z",
            "2024-01-01T24:00:00.000Z",
            "2024-01-01T00:60:00.000Z",
            "2024-01-01T00:00:60.000Z",
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:00:00.00Z",
            "2024-01-01T00:00:00.0000Z",
            "2024-01-01t00:00:00.000Z",
            "2024-01-01T00:00:00.000z",
            "2024-01-01T00:00:00.000+00:00",
            " 2024-01-01T00:00:00.000Z",
        ]

        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_timestamp(value)  # type: ignore[arg-type]

    def test_format_timestamp_rejects_naive_non_utc_and_submillisecond_values(self) -> None:
        invalid = [
            None,
            "2024-01-01T00:00:00.000Z",
            datetime(2024, 1, 1),  # noqa: DTZ001 - deliberately invalid naive input
            datetime(2024, 1, 1, tzinfo=timezone(timedelta(hours=7))),
            datetime(2024, 1, 1, microsecond=1, tzinfo=timezone.utc),
            datetime(2024, 1, 1, microsecond=123001, tzinfo=timezone.utc),
        ]

        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                format_timestamp(value)  # type: ignore[arg-type]


class MessageContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = {
            "source_namespace": "relic/บัญชี-primary",
            "source_message_id": "msg-😀-1",
            "peer_name": "Neo\nOracle",
            "role": "assistant",
            "content": "สวัสดี \"world\" 😀\t/",
            "source_created_at": "2026-09-20T09:08:07.006Z",
            "in_reply_to": None,
        }

    def test_canonical_message_has_exact_order_compact_utf8_and_null(self) -> None:
        expected = (
            '{"source_namespace":"relic/บัญชี-primary",'
            '"source_message_id":"msg-😀-1",'
            '"peer_name":"Neo\\nOracle",'
            '"role":"assistant",'
            '"content":"สวัสดี \\"world\\" 😀\\t/",'
            '"source_created_at":"2026-09-20T09:08:07.006Z",'
            '"in_reply_to":null}'
        ).encode()

        self.assertEqual(canonical_message(self.payload), expected)

    def test_canonical_message_ignores_input_insertion_order(self) -> None:
        reversed_payload = dict(reversed(list(self.payload.items())))

        self.assertEqual(canonical_message(reversed_payload), canonical_message(self.payload))

    def test_message_digest_is_domain_separated_lowercase_sha256(self) -> None:
        digest = message_digest(self.payload)
        self.assertEqual(
            digest,
            "2b0da0e3bbaf7a06074d9f02b890530e51979e248080a7b020fa0b501ac3fbab",
        )
        self.assertRegex(digest, re.compile(r"\A[0-9a-f]{64}\Z"))

    def test_changed_source_field_changes_digest(self) -> None:
        original = message_digest(self.payload)

        for field in self.payload:
            changed = dict(self.payload)
            changed[field] = {
                "source_namespace": "other",
                "source_message_id": "other",
                "peer_name": "other",
                "role": None,
                "content": "other",
                "source_created_at": None,
                "in_reply_to": "other",
            }[field]
            with self.subTest(field=field):
                self.assertNotEqual(message_digest(changed), original)

    def test_nullable_fields_accept_null_and_content_accepts_empty_string(self) -> None:
        payload = dict(self.payload)
        payload.update(role=None, content="", source_created_at=None, in_reply_to=None)

        encoded = canonical_message(payload).decode("utf-8")
        self.assertIn('"role":null', encoded)
        self.assertIn('"content":""', encoded)
        self.assertIn('"source_created_at":null', encoded)
        self.assertIn('"in_reply_to":null', encoded)

    def test_exact_keys_are_required_with_no_extras(self) -> None:
        missing = dict(self.payload)
        del missing["in_reply_to"]
        extra = dict(self.payload, revision=1)

        for payload in [missing, extra]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                canonical_message(payload)

    def test_message_field_types_and_values_are_validated(self) -> None:
        invalid_changes = [
            ("source_namespace", ""),
            ("source_namespace", None),
            ("source_message_id", ""),
            ("peer_name", ""),
            ("role", 1),
            ("content", None),
            ("source_created_at", "2026-09-20T09:08:07Z"),
            ("in_reply_to", 1),
        ]

        for field, value in invalid_changes:
            payload = dict(self.payload)
            payload[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                canonical_message(payload)

    def test_unpaired_surrogates_are_rejected_in_every_string_field(self) -> None:
        for field in self.payload:
            if field == "source_created_at":
                continue
            payload = dict(self.payload)
            payload[field] = "bad\ud800"
            with self.subTest(field=field), self.assertRaises(ValueError):
                canonical_message(payload)

    def test_payload_must_be_a_plain_string_keyed_mapping(self) -> None:
        for payload in [None, [], "message"]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                canonical_message(payload)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
