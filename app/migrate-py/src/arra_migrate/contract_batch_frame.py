"""Batch request framing, closed protocol errors, and worker defaults for the
Python side of the arra-contract-batch/v1 bridge.

Everything here is protocol/JSON-shape checking or plain data -- never
canonicalization. See app/docs/contracts/revision-evidence-v1.md §7.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BATCH_VERSION = "arra-contract-batch/v1"
ERROR_VERSION = "arra-error/v1"

OPS = frozenset({"revision", "verify_revision", "target", "verify_target", "source_replay", "revision_replay"})
ERROR_CODES = frozenset({
    "invalid_json", "duplicate_key", "invalid_unicode", "invalid_type", "missing_field",
    "unexpected_field", "invalid_value", "out_of_range", "limit_exceeded", "unsupported_version",
    "snapshot_position", "digest_mismatch", "target_key_mismatch", "scope_mismatch", "worker_failure",
})

MAX_ITEMS = 64
MAX_DOCUMENT_BYTES = 1 * 1024 * 1024
MAX_TRANSPORT_BYTES = 16 * 1024 * 1024
MAX_CORRELATION_ID_BYTES = 128
DEADLINE_SECONDS = 30.0

_HERE = Path(__file__).resolve()
DEFAULT_WORKER_SCRIPT = _HERE.parents[3] / "server" / "src" / "contracts" / "batch-worker.ts"
DEFAULT_WORKER_CWD = _HERE.parents[3] / "server"


class ContractError(ValueError):
    """A closed `arra-error/v1` error, either from the worker or from local protocol checks."""

    def __init__(self, code: str, path: str, message: str, item_id: str | None = None) -> None:
        if code not in ERROR_CODES:
            code = "worker_failure"
        super().__init__(f"{code} at {path!r}: {message}")
        self.code = code
        self.path = path
        self.detail_message = message
        self.item_id = item_id

    def to_dict(self) -> dict[str, Any]:
        return {"version": ERROR_VERSION, "code": self.code, "path": self.path, "message": self.detail_message}


@dataclass(frozen=True)
class BatchItem:
    id: str
    op: str
    payload: Any


@dataclass(frozen=True)
class BatchResult:
    id: str
    op: str
    value: Any


@dataclass(frozen=True)
class WorkerConfig:
    bun: str = "bun"
    script: Path = DEFAULT_WORKER_SCRIPT
    cwd: Path = DEFAULT_WORKER_CWD
    deadline_seconds: float = DEADLINE_SECONDS


# ---------------------------------------------------------------------------
# Strict JSON helpers (protocol checking only -- never canonicalization)
# ---------------------------------------------------------------------------

MAX_DEPTH = 64


def _max_json_depth(text: str) -> int:
    """Bracket depth of a JSON text WITHOUT building a tree. Respects strings and escapes.

    Runs before json.loads so an adversarial worker cannot drive the parser
    into unbounded recursion. Root container counts 1, as in the contract.
    """
    depth = 0
    deepest = 0
    in_string = False
    escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "[{":
            depth += 1
            if depth > deepest:
                deepest = depth
                if deepest > MAX_DEPTH:
                    return deepest
        elif ch in "]}":
            depth -= 1
    return deepest


def _require_str(value: Any, where: str) -> str:
    """A real `str` with no unpaired surrogates. Checked BEFORE any hash, encode or set lookup."""
    if not isinstance(value, str):
        raise ContractError("invalid_type", where, "expected string")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ContractError("invalid_unicode", where, "unpaired surrogate in worker output") from error
    return value


_MALFORMED_OUTPUT = (TypeError, ValueError, KeyError, AttributeError, UnicodeError, RecursionError)

_NANOID_ALPHABET = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")


def _is_nanoid21(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 21 and all(c in _NANOID_ALPHABET for c in value)


def _require_pointer(value: Any, where: str) -> str:
    """RFC 6901: empty, or '/'-prefixed tokens where '~' appears only as ~0 or ~1."""
    text = _require_str(value, where)
    if text == "":
        return text
    if not text.startswith("/"):
        raise ContractError("invalid_value", where, "JSON Pointer must be empty or start with /")
    for token in text[1:].split("/"):
        i = 0
        while i < len(token):
            if token[i] == "~":
                if i + 1 >= len(token) or token[i + 1] not in "01":
                    raise ContractError("invalid_value", where, "JSON Pointer '~' must be escaped as ~0 or ~1")
                i += 2
            else:
                i += 1
    return text


def _validate_request_value(value: Any, path: str) -> None:
    """Closed check that a request value is plain JSON BEFORE json.dumps can raise.

    json.dumps would otherwise leak UnicodeEncodeError (lone surrogate),
    ValueError (NaN/Infinity with allow_nan=False) or TypeError (non-JSON
    object) -- none of which are closed contract errors.
    """
    if value is None or value is True or value is False:
        return
    if isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > 2**63:
            raise ContractError("out_of_range", path, "ordinary JSON number out of supported range; use an Int64 string")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ContractError("invalid_value", path, "non-finite number")
        return
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ContractError("invalid_unicode", path, "unpaired surrogate") from error
        return
    if isinstance(value, list):
        for i, item in enumerate(value):
            _validate_request_value(item, f"{path}/{i}")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ContractError("invalid_type", path, "object keys must be strings")
            try:
                key.encode("utf-8")
            except UnicodeEncodeError as error:
                raise ContractError("invalid_unicode", path, "unpaired surrogate in key") from error
            _validate_request_value(item, f"{path}/{key.replace('~', '~0').replace('/', '~1')}")
        return
    raise ContractError("invalid_type", path, f"not a JSON value: {type(value).__name__}")


def _json_equal(a: Any, b: Any) -> bool:
    """Type-aware JSON equality. Python's `==` says True == 1 and 1.0 == 1; JSON does not.

    Booleans, null, strings, numbers, arrays and objects are distinct kinds.
    Numbers compare as binary64 values, so -0.0 == 0.0 and 1 == 1.0 (both
    are the SAME JSON number under the contract's binary64 rule).
    """
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a is b
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    if isinstance(a, (int, float)) or isinstance(b, (int, float)):
        return isinstance(a, (int, float)) and isinstance(b, (int, float)) and float(a) == float(b)
    if isinstance(a, list) or isinstance(b, list):
        return isinstance(a, list) and isinstance(b, list) and len(a) == len(b) and all(_json_equal(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict) or isinstance(b, dict):
        return isinstance(a, dict) and isinstance(b, dict) and a.keys() == b.keys() and all(_json_equal(a[k], b[k]) for k in a)
    return False


def _require_document(value: Any, where: str) -> str:
    """A returned JSON document string: real str, valid Unicode, within the per-document cap."""
    text = _require_str(value, where)
    size = len(text.encode("utf-8"))
    if size > MAX_DOCUMENT_BYTES:
        raise ContractError("limit_exceeded", where, f"returned document is {size} bytes; limit {MAX_DOCUMENT_BYTES}")
    return text


def _reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ContractError("duplicate_key", "", f"duplicate key {key!r} in worker output")
        out[key] = value
    return out


def _reject_nonfinite(text: str) -> Any:
    raise ContractError("invalid_value", "", f"non-finite number {text!r} in worker output")


def strict_binary64_loads(text: str) -> Any:
    """Parse JSON with binary64 numeric semantics and duplicate-key rejection.

    Used ONLY to check the worker's own output for internal consistency. Every
    number becomes a float, mirroring the contract's binary64 rule, so that a
    large integer literal compares the way Bun would have parsed it.
    """
    if not isinstance(text, str):
        raise ContractError("invalid_type", "", "expected JSON text")
    if _max_json_depth(text) > MAX_DEPTH:
        raise ContractError("limit_exceeded", "", f"worker output nests deeper than {MAX_DEPTH}")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicates,
            parse_int=float,
            parse_float=float,
            parse_constant=_reject_nonfinite,
        )
    except json.JSONDecodeError as error:
        raise ContractError("invalid_json", "", f"worker output is not strict JSON: {error.msg}") from error
    except RecursionError as error:
        raise ContractError("limit_exceeded", "", "worker output nests too deeply") from error
    _check_finite_and_unicode(value)
    return value


def _check_finite_and_unicode(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ContractError("invalid_value", "", "non-finite number in worker output")
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ContractError("invalid_unicode", "", "unpaired surrogate in worker output") from error
    elif isinstance(value, list):
        for item in value:
            _check_finite_and_unicode(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            _check_finite_and_unicode(key)
            _check_finite_and_unicode(item)


def _is_sha256_hex(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _require_closed(value: Any, keys: Sequence[str], where: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractError("invalid_type", where, "expected object")
    for key in keys:
        if key not in value:
            raise ContractError("missing_field", f"{where}/{key}", f"missing {key!r}")
    extras = sorted(k for k in value if k not in keys)
    if extras:
        raise ContractError("unexpected_field", f"{where}/{extras[0]}", f"unexpected {extras[0]!r}")
    return value


# ---------------------------------------------------------------------------
# Request framing
# ---------------------------------------------------------------------------

def _validate_items(items: Sequence[BatchItem]) -> None:
    """Two passes, matching the worker: ALL identities first, then payloads in order.

    §7 orders these deliberately. A single pass would report an oversized
    payload on item 0 and never reach a duplicate id on item 2, so Python and
    Bun would disagree about which error a batch produces. Identity errors
    outrank every payload error regardless of position.
    """
    if len(items) > MAX_ITEMS:
        raise ContractError("limit_exceeded", "/items", f"at most {MAX_ITEMS} items")

    # ---- pass 1: identity and op, for every item ----
    seen: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item.id, str) or item.id == "":
            raise ContractError("invalid_value", f"/items/{index}/id", "id must be a nonempty string")
        try:
            encoded = item.id.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ContractError("invalid_unicode", f"/items/{index}/id", "id has unpaired surrogate") from error
        if len(encoded) > MAX_CORRELATION_ID_BYTES:
            raise ContractError("limit_exceeded", f"/items/{index}/id", f"id exceeds {MAX_CORRELATION_ID_BYTES} bytes")
        if item.id in seen:
            raise ContractError("invalid_value", f"/items/{index}/id", "duplicate correlation id")
        seen.add(item.id)
        if not isinstance(item.op, str):   # a list here used to raise TypeError from set membership
            raise ContractError("invalid_type", f"/items/{index}/op", "op must be a string")
        if item.op not in OPS:
            raise ContractError("invalid_value", f"/items/{index}/op", f"unknown op {item.op!r}")

    # ---- pass 2: payloads, in request order, first error wins ----
    for index, item in enumerate(items):
        _validate_request_value(item.payload, f"/items/{index}/payload")
        # The bytes Python actually emits for this payload (§7); the worker
        # separately measures the RAW span it receives on the wire.
        payload_bytes = len(json.dumps(item.payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
        if payload_bytes > MAX_DOCUMENT_BYTES:
            raise ContractError("limit_exceeded", f"/items/{index}/payload", f"payload is {payload_bytes} bytes; limit {MAX_DOCUMENT_BYTES}")


def encode_request(items: Sequence[BatchItem]) -> bytes:
    """Frame a request. Framing serialization is NOT canonicalization: raw
    JSON-valued column strings pass through unchanged as JSON strings."""
    _validate_items(items)
    document = {
        "version": BATCH_VERSION,
        "items": [{"id": it.id, "op": it.op, "payload": it.payload} for it in items],
    }
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) + 1 > MAX_TRANSPORT_BYTES:
        raise ContractError("limit_exceeded", "", f"request exceeds {MAX_TRANSPORT_BYTES} bytes")
    return encoded + b"\n"
