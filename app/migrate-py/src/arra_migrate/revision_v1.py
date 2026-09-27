"""Fail-closed Python adapter for the Bun `arra-contract-batch/v1` worker.

Bun is the ONE revision/evidence canonicalizer. This module never encodes
canonical bytes itself: it frames a bounded batch, runs the worker as an
argument-array subprocess with a hard deadline and streaming byte caps,
validates the closed protocol shape of what comes back, and recomputes the
domain-separated SHA-256 digests over the returned canonical texts so a
truncated or tampered response cannot pass. It also cross-checks the returned
logical envelope against the returned normalized columns using strict
binary64 JSON parsing -- an internal-consistency check, NOT a second encoder.

It must not compare raw governed input using Python's arbitrary-precision
integers (input 9007199254740993 legitimately becomes 9007199254740992 under
binary64) and must never reserialize output with json.dumps. Python is not a
second canonicalizer.

Not imported by the active migrator, storage path, or any runtime route.
Does not open LanceDB. Contract: app/docs/contracts/revision-evidence-v1.md §7.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
import time
from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from .contract_batch_frame import (
    _MALFORMED_OUTPUT,
    BATCH_VERSION,
    DEFAULT_WORKER_CWD,
    DEFAULT_WORKER_SCRIPT,
    ERROR_CODES,
    ERROR_VERSION,
    MAX_DEPTH,
    MAX_DOCUMENT_BYTES,
    MAX_TRANSPORT_BYTES,
    BatchItem,
    BatchResult,
    ContractError,
    WorkerConfig,
    _is_nanoid21,
    _json_equal,
    _max_json_depth,
    _reject_duplicates,
    _reject_nonfinite,
    _require_closed,
    _require_document,
    _require_pointer,
    _require_str,
    encode_request,
    strict_binary64_loads,
)
from .contract_v1 import format_timestamp, parse_int64, parse_timestamp

REVISION_DOMAIN = b"arra-revision/v1\n"
TARGET_DOMAIN = b"arra-target/v1\n"

MAX_STDERR_BYTES = 64 * 1024

REVISION_COLUMNS = ("fields", "term_snapshot_json", "link_snapshot_json", "h_metadata", "internal_metadata")
DISPLAY_ONLY = {"relic_session": {"title_snapshot"}, "issue": {"url"}, "discussion": {"url"}}




# ---------------------------------------------------------------------------
# Subprocess with deadline + streaming caps
# ---------------------------------------------------------------------------

class _CappedReader(threading.Thread):
    """Drain one pipe with UNBUFFERED reads and kill the child the moment the cap is crossed.

    `os.read` on the raw descriptor returns as soon as any bytes are available,
    so a cap+1 tail is seen immediately rather than after a 64 KiB buffer
    fills or the child exits. Overflow triggers the kill callback from THIS
    thread; the main thread does not have to notice first.
    """

    def __init__(self, stream: Any, cap: int, on_overflow: Any) -> None:
        super().__init__(daemon=True)
        self.fd = stream.fileno()
        self.cap = cap
        self.on_overflow = on_overflow
        self.buffer = bytearray()
        self.overflow = False
        self.failed: BaseException | None = None

    def run(self) -> None:
        try:
            while True:
                try:
                    chunk = os.read(self.fd, 65536)
                except (OSError, ValueError):
                    break
                if not chunk:
                    break
                if self.overflow:
                    continue  # already killing; drain without retaining
                if len(self.buffer) + len(chunk) > self.cap:
                    self.overflow = True
                    self.buffer.clear()
                    self.on_overflow()
                    continue
                self.buffer.extend(chunk)
        except BaseException as error:  # noqa: BLE001 - surfaced to the caller as worker_failure
            self.failed = error


def _run_worker(request: bytes, config: WorkerConfig) -> tuple[int, bytes, bytes]:
    """Run one bounded batch under ONE deadline covering stdin delivery, execution and output drain.

    Returns (returncode, stdout, stderr). Raises ContractError for timeout,
    overflow or infrastructure failure; in every such case the child has been
    killed and reaped before this function returns.
    """
    script = Path(config.script)
    if not script.is_file():
        raise ContractError("worker_failure", "", f"worker script not found: {script}")
    argv = [config.bun, "run", str(script)]
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), "LANG": "C.UTF-8"}
    deadline = time.monotonic() + config.deadline_seconds
    try:
        proc = subprocess.Popen(  # argument array, shell=False, explicit script path
            argv,
            cwd=str(config.cwd),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            bufsize=0,
        )
    except OSError as error:
        raise ContractError("worker_failure", "", f"cannot start worker: {error}") from error

    kill_lock = threading.Lock()
    killed = threading.Event()

    def _kill() -> None:
        with kill_lock:
            if killed.is_set():
                return
            killed.set()
        try:
            proc.kill()
        except OSError:
            pass

    out = _CappedReader(proc.stdout, MAX_TRANSPORT_BYTES, _kill)
    err = _CappedReader(proc.stderr, MAX_STDERR_BYTES, _kill)
    out.start()
    err.start()
    writer = threading.Thread(target=_write_all, args=(proc.stdin, request), daemon=True)
    writer.start()

    def _remaining() -> float:
        return deadline - time.monotonic()

    try:
        # One loop, one clock: exit when the child is gone, when a reader
        # crossed its cap (it already sent SIGKILL), or when time runs out.
        while proc.poll() is None:
            if out.overflow or err.overflow or _remaining() <= 0:
                _kill()
                break
            time.sleep(0.005)
        # Reap within the SAME deadline; a child that ignores SIGKILL is an infrastructure fault.
        try:
            proc.wait(timeout=max(0.0, _remaining()) + 1.0)
        except subprocess.TimeoutExpired as error:
            raise ContractError("worker_failure", "", "worker did not exit after kill") from error
        # Draining ends at EOF, which the kill guarantees; bound it by the same clock anyway.
        for reader in (out, err):
            reader.join(timeout=max(0.0, _remaining()) + 1.0)
        writer.join(timeout=max(0.0, _remaining()) + 1.0)
        if out.failed or err.failed:
            raise ContractError("worker_failure", "", f"reader failed: {out.failed or err.failed!r}")
        if out.overflow:
            raise ContractError("limit_exceeded", "", f"worker stdout exceeded {MAX_TRANSPORT_BYTES} bytes; worker killed")
        if err.overflow:
            raise ContractError("limit_exceeded", "", f"worker stderr exceeded {MAX_STDERR_BYTES} bytes; worker killed")
        if killed.is_set():
            raise ContractError("worker_failure", "", f"worker exceeded {config.deadline_seconds}s deadline; worker killed")
        if out.is_alive() or err.is_alive() or writer.is_alive():
            _kill()
            raise ContractError("worker_failure", "", "output drain exceeded the deadline; worker killed")
        return proc.returncode, bytes(out.buffer), bytes(err.buffer)
    finally:
        if proc.poll() is None:
            _kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        for pipe in (proc.stdout, proc.stderr, proc.stdin):
            try:
                if pipe is not None:
                    pipe.close()
            except (OSError, ValueError):
                pass


def _write_all(stream: Any, data: bytes) -> None:
    try:
        stream.write(data)
        stream.flush()
    except (OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except (OSError, ValueError):
            pass


# ---------------------------------------------------------------------------
# Response validation
# ---------------------------------------------------------------------------

def _decode_response(returncode: int, stdout: bytes, stderr: bytes) -> Mapping[str, Any]:
    if returncode != 0:
        tail = stderr[-512:].decode("utf-8", errors="replace")
        raise ContractError("worker_failure", "", f"worker exited {returncode}: {tail.strip()}")
    if len(stdout) > MAX_TRANSPORT_BYTES:
        raise ContractError("limit_exceeded", "", "worker stdout exceeds transport cap")
    body = stdout[:-1] if stdout.endswith(b"\n") else stdout
    if b"\n" in body:
        raise ContractError("worker_failure", "", "worker emitted more than one line on stdout")
    try:
        text = body.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ContractError("invalid_unicode", "", "worker stdout is not valid UTF-8") from error
    if text == "":
        raise ContractError("worker_failure", "", "worker produced no output")
    if _max_json_depth(text) > MAX_DEPTH:
        raise ContractError("limit_exceeded", "", f"worker response nests deeper than {MAX_DEPTH}")
    try:
        response = json.loads(text, object_pairs_hook=_reject_duplicates, parse_constant=_reject_nonfinite)
    except json.JSONDecodeError as error:
        raise ContractError("worker_failure", "", f"worker stdout is not one JSON document: {error.msg}") from error
    except RecursionError as error:
        raise ContractError("limit_exceeded", "", "worker response nests too deeply") from error
    if not isinstance(response, Mapping):
        raise ContractError("worker_failure", "", "worker response is not an object")
    return response


def _validate_error_detail(detail: Any) -> ContractError:
    d = _require_closed(detail, ("version", "code", "path", "message"), "/error/detail")
    version = _require_str(d["version"], "/error/detail/version")
    if version != ERROR_VERSION:
        raise ContractError("worker_failure", "/error/detail/version", "unexpected error version")
    code = _require_str(d["code"], "/error/detail/code")   # a list here used to raise TypeError from set membership
    if code not in ERROR_CODES:
        raise ContractError("worker_failure", "/error/detail/code", f"unknown error code {code!r}")
    path = _require_pointer(d["path"], "/error/detail/path")
    message = _require_str(d["message"], "/error/detail/message")
    return ContractError(code, path, message)


def _validate_response(response: Mapping[str, Any], items: Sequence[BatchItem]) -> list[BatchResult]:
    """Validate the closed protocol. Malformed worker output becomes a closed error.

    The mapping is deliberately narrow: only the exception classes that
    malformed DATA can raise inside this validator are converted, and only
    here, so a genuine programming bug elsewhere still surfaces as itself.
    """
    try:
        return _validate_response_inner(response, items)
    except ContractError:
        raise
    except _MALFORMED_OUTPUT as error:
        raise ContractError("worker_failure", "", f"malformed worker output: {type(error).__name__}: {error}") from error


def _validate_response_inner(response: Mapping[str, Any], items: Sequence[BatchItem]) -> list[BatchResult]:
    r = _require_closed(response, ("version", "ok", "results", "error"), "")
    _require_str(r["version"], "/version")
    if r["version"] != BATCH_VERSION:
        raise ContractError("unsupported_version", "/version", f"expected {BATCH_VERSION}")
    if r["ok"] is not True and r["ok"] is not False:
        raise ContractError("invalid_type", "/ok", "ok must be a literal boolean")
    if not isinstance(r["results"], list):
        raise ContractError("invalid_type", "/results", "results must be an array")

    if r["ok"] is False:
        if r["results"] != []:
            raise ContractError("worker_failure", "/results", "failure response must carry no results")
        e = _require_closed(r["error"], ("item_id", "detail"), "/error")
        item_id = e["item_id"]
        if item_id is not None:
            item_id = _require_str(item_id, "/error/item_id")
            if item_id not in {it.id for it in items}:
                raise ContractError("worker_failure", "/error/item_id", "item_id must be null or a request item id")
        error = _validate_error_detail(e["detail"])
        error.item_id = item_id
        raise error

    if r["error"] is not None:
        raise ContractError("worker_failure", "/error", "success response must carry error: null")
    if len(r["results"]) != len(items):
        raise ContractError("worker_failure", "/results", f"expected {len(items)} results, got {len(r['results'])}")
    results: list[BatchResult] = []
    for index, (raw, item) in enumerate(zip(r["results"], items, strict=True)):
        where = f"/results/{index}"
        entry = _require_closed(raw, ("id", "op", "value"), where)
        _require_str(entry["id"], f"{where}/id")
        _require_str(entry["op"], f"{where}/op")
        if entry["id"] != item.id:
            raise ContractError("worker_failure", f"{where}/id", "result id out of order")
        if entry["op"] != item.op:
            raise ContractError("worker_failure", f"{where}/op", "result op does not match request")
        _verify_value(item.op, item.payload, entry["value"], where)
        results.append(BatchResult(id=item.id, op=item.op, value=entry["value"]))
    return results


def _verify_value(op: str, payload: Any, value: Any, where: str) -> None:
    if op in ("revision", "verify_revision"):
        v = _require_closed(value, ("canonical_json", "content_digest", "columns"), f"{where}/value")
        canonical = _require_document(v["canonical_json"], f"{where}/value/canonical_json")
        _require_str(v["content_digest"], f"{where}/value/content_digest")
        expected = hashlib.sha256(REVISION_DOMAIN + canonical.encode("utf-8")).hexdigest()
        if v["content_digest"] != expected:
            raise ContractError("digest_mismatch", f"{where}/value/content_digest", "recomputed digest differs")
        cols = _require_closed(v["columns"], REVISION_COLUMNS, f"{where}/value/columns")
        envelope = strict_binary64_loads(v["canonical_json"])
        _check_revision_consistency(envelope, cols, payload, f"{where}/value")
    elif op in ("target", "verify_target"):
        v = _require_closed(value, ("target_json", "key_json", "target_key"), f"{where}/value")
        _require_document(v["target_json"], f"{where}/value/target_json")
        key_json = _require_document(v["key_json"], f"{where}/value/key_json")   # a lone surrogate here used to escape as UnicodeEncodeError
        _require_str(v["target_key"], f"{where}/value/target_key")
        expected = hashlib.sha256(TARGET_DOMAIN + key_json.encode("utf-8")).hexdigest()
        if v["target_key"] != expected:
            raise ContractError("target_key_mismatch", f"{where}/value/target_key", "recomputed key differs")
        key = strict_binary64_loads(v["key_json"])
        target = strict_binary64_loads(v["target_json"])
        _check_target_consistency(key, target, payload, f"{where}/value")
    elif op in ("source_replay", "revision_replay"):
        v = _require_closed(value, ("outcome", "original_id"), f"{where}/value")
        _require_str(v["outcome"], f"{where}/value/outcome")
        if v["outcome"] not in ("new", "idempotent", "conflict"):
            raise ContractError("invalid_value", f"{where}/value/outcome", "unknown outcome")
        if v["outcome"] == "idempotent" and not _is_nanoid21(v["original_id"]):
            raise ContractError("invalid_value", f"{where}/value/original_id", "idempotent requires a nanoid21 original_id")
        if v["outcome"] != "idempotent" and v["original_id"] is not None:
            raise ContractError("invalid_value", f"{where}/value/original_id", "original_id must be null unless idempotent")


def _check_revision_consistency(envelope: Any, cols: Mapping[str, Any], payload: Any, where: str) -> None:
    """Returned envelope vs returned columns: same values under binary64 parsing.

    Compares the worker's OWN two representations against each other -- never
    the raw governed input, which only Bun may parse.
    """
    if not isinstance(envelope, Mapping):
        raise ContractError("invalid_type", f"{where}/canonical_json", "envelope must be an object")
    for column, envelope_key in (("fields", "fields"), ("term_snapshot_json", "terms"), ("link_snapshot_json", "links"), ("h_metadata", "h_metadata"), ("internal_metadata", "internal_metadata")):
        stored = cols[column]
        if stored is None:
            if envelope.get(envelope_key) is not None:
                raise ContractError("invalid_value", f"{where}/columns/{column}", "null column but non-null envelope value")
            continue
        _require_document(stored, f"{where}/columns/{column}")
        # Type-aware: `true` in the envelope vs `1` in the column is a DISAGREEMENT.
        if not _json_equal(strict_binary64_loads(stored), envelope.get(envelope_key)):
            raise ContractError("invalid_value", f"{where}/columns/{column}", "column disagrees with logical envelope")
    # Scalar scope/version identifiers must come back unchanged from the request.
    content = payload.get("content") if isinstance(payload, Mapping) else None
    if not isinstance(content, Mapping):
        return
    for key in ("workspace_name", "node_id", "base_revision_id", "schema_version", "canonical_version"):
        if content.get(key) != envelope.get(key):
            raise ContractError("invalid_value", f"{where}/canonical_json/{key}", "scope or version identifier changed in transit")


def _check_target_consistency(key: Any, target: Any, payload: Any, where: str) -> None:
    k = _require_closed(key, ("workspace_name", "target_kind", "identity"), f"{where}/key_json")
    _require_str(k["target_kind"], f"{where}/key_json/target_kind")
    if isinstance(payload, Mapping) and (k["workspace_name"] != payload.get("workspace_name") or k["target_kind"] != payload.get("target_kind")):
        raise ContractError("invalid_value", f"{where}/key_json", "workspace or kind changed in transit")
    if not isinstance(target, Mapping) or not isinstance(k["identity"], Mapping):
        raise ContractError("invalid_type", f"{where}", "target and identity must be objects")
    dropped = DISPLAY_ONLY.get(k["target_kind"], set())
    expected_identity = {name: value for name, value in target.items() if name not in dropped}
    if not _json_equal(dict(k["identity"]), expected_identity):
        raise ContractError("invalid_value", f"{where}/key_json/identity", "identity is not target minus display-only keys")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_batch(items: Sequence[BatchItem], config: WorkerConfig | None = None) -> list[BatchResult]:
    """Run one bounded batch against the Bun worker. All-or-nothing.

    Raises ContractError for any contract, protocol, or infrastructure
    failure. Returns validated results in request order only when EVERY item
    succeeded and every returned digest recomputed correctly.
    """
    cfg = config or WorkerConfig()
    request = encode_request(items)
    returncode, stdout, stderr = _run_worker(request, cfg)
    response = _decode_response(returncode, stdout, stderr)
    return _validate_response(response, items)


# ---------------------------------------------------------------------------
# Fixture adapters at the Arrow row boundary (no production migration here)
# ---------------------------------------------------------------------------

def timestamp_to_naive_us(value: str | None) -> datetime | None:
    """Canonical UTC-ms text -> naive UTC datetime for a timestamp[us] column."""
    if value is None:
        return None
    return parse_timestamp(value).replace(tzinfo=None)


def naive_us_to_timestamp(value: datetime | None) -> str | None:
    """Naive UTC datetime -> canonical text. REJECTS sub-millisecond values rather than rounding."""
    if value is None:
        return None
    if value.tzinfo is not None:
        raise ValueError("expected a naive UTC datetime from the physical column")
    if value.microsecond % 1000 != 0:
        raise ValueError("stored timestamp has sub-millisecond precision; refusing to round")
    from datetime import timezone

    return format_timestamp(value.replace(tzinfo=timezone.utc))


def int64_text_to_value(value: str) -> int:
    """Canonical Int64 text -> int, only at the Arrow row boundary."""
    return parse_int64(value)


__all__ = [
    "BATCH_VERSION",
    "DEFAULT_WORKER_CWD",
    "DEFAULT_WORKER_SCRIPT",
    "ERROR_VERSION",
    "MAX_DOCUMENT_BYTES",
    "BatchItem",
    "BatchResult",
    "ContractError",
    "WorkerConfig",
    "encode_request",
    "int64_text_to_value",
    "naive_us_to_timestamp",
    "run_batch",
    "strict_binary64_loads",
    "timestamp_to_naive_us",
]
