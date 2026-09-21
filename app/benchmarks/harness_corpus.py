"""Provenance-qualified corpus + qrels loading for the #7 benchmark harness.

A retrieval number is uninterpretable without knowing what it was measured on.
This module makes the synthetic/held-out distinction a STRUCTURAL property of
the loaded object, not a convention a caller can forget or mislabel:

* `Provenance.kind` is never accepted as a field from the input payload. It is
  stamped by which loader function was called -- `load_synthetic_corpus`
  ignores any "kind" the payload tries to supply, and there is no function
  that lets a caller choose the kind directly. The only way to produce a
  `Provenance` object at all is through one of the two named loaders.
* A `Qrels` can only be paired with a `Corpus` of the SAME kind (checked in
  `bind_qrels`). A synthetic qrels file cannot be scored against a held-out
  corpus or vice versa -- that mismatch is refused outright, not merged.
* Every report the runner emits carries the `Provenance` object through
  untouched, so "synthetic" cannot become "held out" by omission on the way
  to the final JSON.

This module never fetches or constructs a held-out corpus itself -- it only
loads one a caller already has on disk, and it never uploads or transmits
anything. Held-out corpora are expected to stay local (private memory
content); this loader does no network I/O at all.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

__all__ = [
    "CorpusInputError",
    "Provenance",
    "Corpus",
    "Query",
    "Qrels",
    "load_synthetic_corpus",
    "load_held_out_corpus",
    "load_synthetic_qrels",
    "load_held_out_qrels",
    "bind_qrels",
]

SYNTHETIC = "synthetic"
HELD_OUT = "held_out"
_KINDS = (SYNTHETIC, HELD_OUT)


class CorpusInputError(ValueError):
    """The corpus or qrels payload is not one this loader will accept."""


@dataclass(frozen=True)
class Provenance:
    kind: str  # "synthetic" | "held_out" -- set ONLY by a loader function below
    label: str
    source: str
    created: str


@dataclass(frozen=True)
class Corpus:
    provenance: Provenance
    document_ids: tuple


@dataclass(frozen=True)
class Query:
    id: str
    relevant_ids: frozenset
    lang: str | None = None
    purpose: str | None = None


@dataclass(frozen=True)
class Qrels:
    provenance: Provenance
    queries: tuple


def _dict(value, where: str) -> dict:
    if not isinstance(value, dict):
        raise CorpusInputError(f"{where}: expected an object")
    return value


def _text(value, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise CorpusInputError(f"{where}: expected a non-empty string")
    return value


def _list(value, where: str) -> list:
    if not isinstance(value, list):
        raise CorpusInputError(f"{where}: expected an array")
    return value


def _read(payload) -> dict:
    """Accept a dict directly, or JSON bytes/str -- never a filesystem path.

    Callers are responsible for reading their own files; this function does
    no I/O so it cannot be pointed at a network location by accident.
    """
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, (bytes, bytearray, str)):
        try:
            parsed = json.loads(payload)
        except ValueError as exc:
            raise CorpusInputError(f"invalid JSON: {exc}") from exc
        return _dict(parsed, "document")
    raise CorpusInputError("payload must be a dict, JSON bytes, or JSON str")


def _build_provenance(kind: str, payload: dict) -> Provenance:
    assert kind in _KINDS  # internal misuse, not a caller-input error
    # "kind" in the payload, if present, is IGNORED -- it can never override
    # which loader function the caller chose to call.
    return Provenance(
        kind=kind,
        label=_text(payload.get("label"), "provenance.label"),
        source=_text(payload.get("source"), "provenance.source"),
        created=_text(payload.get("created"), "provenance.created"),
    )


def _build_corpus(kind: str, payload) -> Corpus:
    document = _read(payload)
    provenance = _build_provenance(kind, _dict(document.get("provenance"), "corpus.provenance"))
    raw_ids = _list(document.get("document_ids"), "corpus.document_ids")
    if not raw_ids:
        raise CorpusInputError("corpus.document_ids must be non-empty")
    ids = tuple(_text(value, "corpus.document_ids[]") for value in raw_ids)
    if len(set(ids)) != len(ids):
        raise CorpusInputError("corpus.document_ids must not contain duplicates")
    return Corpus(provenance=provenance, document_ids=ids)


def _build_qrels(kind: str, payload) -> Qrels:
    document = _read(payload)
    provenance = _build_provenance(kind, _dict(document.get("provenance"), "qrels.provenance"))
    raw_queries = _list(document.get("queries"), "qrels.queries")
    if not raw_queries:
        raise CorpusInputError("qrels.queries must be non-empty")
    queries = []
    seen_ids = set()
    for entry in raw_queries:
        fields = _dict(entry, "qrels.queries[]")
        query_id = _text(fields.get("id"), "qrels.queries[].id")
        if query_id in seen_ids:
            raise CorpusInputError(f"duplicate query id: {query_id}")
        seen_ids.add(query_id)
        relevant = [_text(v, "qrels.queries[].relevant_ids[]") for v in _list(fields.get("relevant_ids"), "qrels.queries[].relevant_ids")]
        if not relevant:
            raise CorpusInputError(f"query {query_id}: relevant_ids must be non-empty")
        lang = fields.get("lang")
        purpose = fields.get("purpose")
        queries.append(
            Query(
                id=query_id,
                relevant_ids=frozenset(relevant),
                lang=_text(lang, "qrels.queries[].lang") if lang is not None else None,
                purpose=_text(purpose, "qrels.queries[].purpose") if purpose is not None else None,
            )
        )
    return Qrels(provenance=provenance, queries=tuple(queries))


def load_synthetic_corpus(payload) -> Corpus:
    """Load a corpus and stamp it `kind="synthetic"`. This is the ONLY path
    that produces a synthetic corpus -- there is no parameter that changes it."""
    return _build_corpus(SYNTHETIC, payload)


def load_held_out_corpus(payload) -> Corpus:
    """Load a corpus and stamp it `kind="held_out"`. This is the ONLY path
    that produces a held-out corpus -- there is no parameter that changes it.

    Calling this on a fixture you invented does not make it held out; the
    kind describes which function you called, and choosing the wrong one is
    on the caller, exactly as choosing to lie about a fact is always on the
    person stating it. What this DOES guarantee is that a corpus loaded
    through `load_synthetic_corpus` can never silently become "held_out" --
    the two kinds cannot be confused by a typo in the payload.
    """
    return _build_corpus(HELD_OUT, payload)


def load_synthetic_qrels(payload) -> Qrels:
    return _build_qrels(SYNTHETIC, payload)


def load_held_out_qrels(payload) -> Qrels:
    return _build_qrels(HELD_OUT, payload)


def bind_qrels(corpus: Corpus, qrels: Qrels) -> Qrels:
    """Validate a qrels against its corpus. Refuses a kind mismatch and any
    relevant id absent from the corpus. Returns `qrels` unchanged on success."""
    if corpus.provenance.kind != qrels.provenance.kind:
        raise CorpusInputError(
            f"provenance kind mismatch: corpus is {corpus.provenance.kind!r}, "
            f"qrels is {qrels.provenance.kind!r}"
        )
    known = set(corpus.document_ids)
    for query in qrels.queries:
        if not query.relevant_ids <= known:
            missing = sorted(query.relevant_ids - known)
            raise CorpusInputError(f"query {query.id}: relevant ids not in corpus: {missing}")
    return qrels
