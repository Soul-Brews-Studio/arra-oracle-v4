"""Required manifest schema for the #7 benchmark harness (R16/A1).

A retrieval number is unusable evidence unless the report also says exactly
what produced it: which engine, which tokenizer options were ACTUALLY
readback from the index (not just requested), what text was indexed, what
the candidate pool was, which embedding model and distance function, and
what the fused-ranking tie rule is. `run_benchmark` (`harness_runner.py`)
takes a `manifest` dict and REFUSES to run at all if any required key is
missing -- a report with a gap in its manifest is exactly the "measured but
undocumented" failure mode #7 was opened to stop.

This module only validates shape (required keys present at every level). It
does not, and cannot, verify that the values are true -- `run_lance.ts` is
responsible for reading real engine/package versions and real index
readbacks rather than hand-typing them; see its own docstring.

Standard library only. No I/O, no model, no index.
"""

from __future__ import annotations

__all__ = ["ManifestInputError", "validate_manifest"]

# Top-level keys `run_benchmark` refuses to run without.
REQUIRED_MANIFEST_KEYS = (
    "engine",              # {"@lancedb/lancedb": "...", "apache-arrow": "..."}
    "tokenizers",          # {"<profile-name>": {<indexDetails readback>}, ...}
    "indexed_text_composition",  # e.g. "${title}\n\n${body}"
    "candidate_limit",     # int: candidate pool size handed to every method
    "eligibility_filter",  # str: the scope/filter applied before ranking
    "embedding",           # see REQUIRED_EMBEDDING_KEYS
    "artifact_sha256",     # see REQUIRED_ARTIFACT_SHA256_KEYS
    "rrf",                 # see REQUIRED_RRF_KEYS
)

REQUIRED_ENGINE_KEYS = ("@lancedb/lancedb", "apache-arrow")
REQUIRED_EMBEDDING_KEYS = ("status", "model", "ollama_digest", "dims", "distance", "normalization")
REQUIRED_ARTIFACT_SHA256_KEYS = ("corpus", "queries", "qrels", "vectors")
REQUIRED_RRF_KEYS = ("k", "tie_rule")


class ManifestInputError(ValueError):
    """The manifest supplied to `run_benchmark` is missing a required key."""


def _require_object(value, keys, where: str) -> None:
    if not isinstance(value, dict):
        raise ManifestInputError(f"manifest.{where} must be an object")
    missing = [key for key in keys if key not in value]
    if missing:
        raise ManifestInputError(f"manifest.{where} missing required keys: {missing}")


def validate_manifest(manifest: dict) -> dict:
    """Raise `ManifestInputError` if any required key is absent at any level.

    A present key whose VALUE is `None` is accepted -- for example
    `embedding.model` is `None` when the vector profile did not run because
    no frozen vectors were supplied (a `not_run` fact belongs in the report,
    not a KeyError). Only the key's ABSENCE is refused; `run_lance.ts` is
    expected to always emit every key, using `None` for "not applicable
    this run" rather than omitting it.

    Returns `manifest` unchanged on success, so this can sit inline in a
    call: `report["manifest"] = validate_manifest(manifest)`.
    """
    if not isinstance(manifest, dict):
        raise ManifestInputError("manifest must be an object")
    missing = [key for key in REQUIRED_MANIFEST_KEYS if key not in manifest]
    if missing:
        raise ManifestInputError(f"manifest missing required keys: {missing}")

    if not isinstance(manifest["tokenizers"], dict) or not manifest["tokenizers"]:
        raise ManifestInputError("manifest.tokenizers must be a non-empty object")

    _require_object(manifest["engine"], REQUIRED_ENGINE_KEYS, "engine")
    _require_object(manifest["embedding"], REQUIRED_EMBEDDING_KEYS, "embedding")
    _require_object(manifest["artifact_sha256"], REQUIRED_ARTIFACT_SHA256_KEYS, "artifact_sha256")
    _require_object(manifest["rrf"], REQUIRED_RRF_KEYS, "rrf")

    return manifest
