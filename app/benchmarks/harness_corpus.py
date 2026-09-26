"""Provenance-qualified corpus + qrels loading for the #7 benchmark harness.

A retrieval number is uninterpretable without knowing what it was measured on,
and without knowing who judged relevance. This module makes both of those
STRUCTURAL properties of the loaded object, not a convention a caller can
forget or mislabel (R16/A2):

* `Corpus.provenance.origin` is one of `synthetic` / `agent_authored` /
  `user_derived`, and `Qrels.provenance.origin` is one of `agent_authored` /
  `independently_judged`. Neither is ever accepted as a field from the input
  payload -- it is stamped by which loader function was called
  (`load_synthetic_corpus` ignores any "origin" the payload tries to supply,
  and there is no function that lets a caller choose the origin directly).
  The only way to produce a `CorpusProvenance`/`QrelsProvenance` at all is
  through one of the named loaders below.
* `held_out` (a qrels can be built from queries that never saw the corpus
  during authoring) is orthogonal to who judged relevance, so it is a
  separate, explicitly required keyword on the qrels loaders -- there is no
  default, because a silently-defaulted `held_out=False` would be exactly
  the kind of claim-by-omission this module exists to prevent.
* `bind_qrels` refuses to pair a corpus/qrels of mismatched relevant ids, AND
  refuses to let a caller bind qrels for a report that will claim a
  `qrels_origin` other than the one the qrels loader actually stamped --
  concretely, agent-authored qrels can never be bound for a report labelled
  `independently_judged`, no matter what an operator script hard-codes.
* Every report the runner emits carries the provenance objects through
  untouched, so "agent_authored" cannot become "independently_judged" by
  omission on the way to the final JSON.

Corpus documents carry their own `title`/`type`/`body`/`lang` (not just an
opaque id), so that the exact text a benchmark indexes is itself part of the
frozen, hashable artifact -- the same JSON file this module loads is also
what `run_lance.ts` reads to build the LanceDB tables it measures.

This module never fetches or constructs a corpus itself -- it only loads one
a caller already has on disk, and it never uploads or transmits anything.
`user_derived` corpora are expected to stay local (private memory content);
this loader does no network I/O at all.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

__all__ = [
    "CorpusInputError",
    "CorpusProvenance",
    "QrelsProvenance",
    "Document",
    "Corpus",
    "Query",
    "Qrels",
    "CORPUS_ORIGINS",
    "QRELS_ORIGINS",
    "load_synthetic_corpus",
    "load_agent_authored_corpus",
    "load_user_derived_corpus",
    "load_agent_authored_qrels",
    "load_independently_judged_qrels",
    "bind_qrels",
]

CORPUS_ORIGINS = ("synthetic", "agent_authored", "user_derived")
QRELS_ORIGINS = ("agent_authored", "independently_judged")


class CorpusInputError(ValueError):
    """The corpus or qrels payload is not one this loader will accept."""


@dataclass(frozen=True)
class CorpusProvenance:
    origin: str  # one of CORPUS_ORIGINS -- set ONLY by a loader function below
    label: str
    source: str
    created: str


@dataclass(frozen=True)
class QrelsProvenance:
    origin: str  # one of QRELS_ORIGINS -- set ONLY by a loader function below
    held_out: bool  # required at load time; never defaulted
    label: str
    source: str
    created: str


@dataclass(frozen=True)
class Document:
    id: str
    title: str
    type: str
    body: str
    lang: str


@dataclass(frozen=True)
class Corpus:
    provenance: CorpusProvenance
    documents: tuple[Document, ...]

    @property
    def document_ids(self) -> tuple[str, ...]:
        return tuple(document.id for document in self.documents)


@dataclass(frozen=True)
class Query:
    id: str
    relevant_ids: frozenset
    lang: str | None = None
    purpose: str | None = None


@dataclass(frozen=True)
class Qrels:
    provenance: QrelsProvenance
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


def _build_corpus_provenance(origin: str, payload: dict) -> CorpusProvenance:
    assert origin in CORPUS_ORIGINS  # internal misuse, not a caller-input error
    # "origin" in the payload, if present, is IGNORED -- it can never override
    # which loader function the caller chose to call.
    return CorpusProvenance(
        origin=origin,
        label=_text(payload.get("label"), "provenance.label"),
        source=_text(payload.get("source"), "provenance.source"),
        created=_text(payload.get("created"), "provenance.created"),
    )


def _build_qrels_provenance(origin: str, held_out: bool, payload: dict) -> QrelsProvenance:
    assert origin in QRELS_ORIGINS  # internal misuse, not a caller-input error
    # "origin"/"held_out" in the payload, if present, are IGNORED -- neither
    # can override the loader function or the required keyword the caller
    # explicitly passed.
    return QrelsProvenance(
        origin=origin,
        held_out=held_out,
        label=_text(payload.get("label"), "provenance.label"),
        source=_text(payload.get("source"), "provenance.source"),
        created=_text(payload.get("created"), "provenance.created"),
    )


def _build_document(payload) -> Document:
    fields = _dict(payload, "corpus.documents[]")
    return Document(
        id=_text(fields.get("id"), "corpus.documents[].id"),
        title=_text(fields.get("title"), "corpus.documents[].title"),
        type=_text(fields.get("type"), "corpus.documents[].type"),
        body=_text(fields.get("body"), "corpus.documents[].body"),
        lang=_text(fields.get("lang"), "corpus.documents[].lang"),
    )


def _build_corpus(origin: str, payload) -> Corpus:
    document = _read(payload)
    provenance = _build_corpus_provenance(origin, _dict(document.get("provenance"), "corpus.provenance"))
    raw_documents = _list(document.get("documents"), "corpus.documents")
    if not raw_documents:
        raise CorpusInputError("corpus.documents must be non-empty")
    documents = tuple(_build_document(entry) for entry in raw_documents)
    ids = [doc.id for doc in documents]
    if len(set(ids)) != len(ids):
        raise CorpusInputError("corpus.documents[].id must not contain duplicates")
    return Corpus(provenance=provenance, documents=documents)


def _build_qrels(origin: str, held_out: bool, payload) -> Qrels:
    document = _read(payload)
    provenance = _build_qrels_provenance(origin, held_out, _dict(document.get("provenance"), "qrels.provenance"))
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
    """Load a corpus and stamp it `origin="synthetic"`. This is the ONLY path
    that produces a synthetic corpus -- there is no parameter that changes it."""
    return _build_corpus("synthetic", payload)


def load_agent_authored_corpus(payload) -> Corpus:
    """Load a corpus and stamp it `origin="agent_authored"`: written by an AI
    agent, not drawn from real memory content and not independently
    authored. This is the ONLY path that produces this origin."""
    return _build_corpus("agent_authored", payload)


def load_user_derived_corpus(payload) -> Corpus:
    """Load a corpus and stamp it `origin="user_derived"`: drawn from real
    memory content the user (Nat, or a third party with consent) owns. This
    is the ONLY path that produces this origin.

    Calling this on a fixture you invented does not make it user-derived; the
    origin describes which function you called, and choosing the wrong one is
    on the caller, exactly as choosing to lie about a fact is always on the
    person stating it. What this DOES guarantee is that a corpus loaded
    through `load_synthetic_corpus`/`load_agent_authored_corpus` can never
    silently become `user_derived` -- the origins cannot be confused by a
    typo in the payload.
    """
    return _build_corpus("user_derived", payload)


def load_agent_authored_qrels(payload, *, held_out: bool) -> Qrels:
    """Load qrels and stamp `origin="agent_authored"`: the relevance
    judgments were written by the same agent that wrote the corpus/queries
    (or another agent), not by an independent human judge. `held_out` is
    required, not defaulted -- state explicitly whether the queries were
    authored without seeing the corpus."""
    return _build_qrels("agent_authored", held_out, payload)


def load_independently_judged_qrels(payload, *, held_out: bool) -> Qrels:
    """Load qrels and stamp `origin="independently_judged"`: relevance was
    judged by someone other than whoever authored the corpus or the queries.
    `held_out` is required, not defaulted, for the same reason as above."""
    return _build_qrels("independently_judged", held_out, payload)


def bind_qrels(corpus: Corpus, qrels: Qrels, *, for_report_qrels_origin: str) -> Qrels:
    """Validate a qrels against its corpus, and against the label the caller
    is about to write into a final report.

    `for_report_qrels_origin` is required -- it is the `qrels_origin` the
    caller (typically `run_benchmark`, or an operator script assembling a
    report) is about to claim in the report it produces. It must equal the
    qrels' own stamped origin exactly. Passing `qrels.provenance.origin`
    itself is always safe and is the ordinary case; this parameter exists so
    that a hard-coded or mistaken claim elsewhere -- pairing agent-authored
    qrels with a report that will say "independently_judged" -- is refused
    HERE, at the one place corpus and qrels are joined, rather than trusted
    to every downstream caller.

    Also refuses any relevant id absent from the corpus. Returns `qrels`
    unchanged on success.
    """
    if for_report_qrels_origin not in QRELS_ORIGINS:
        raise CorpusInputError(f"for_report_qrels_origin must be one of {QRELS_ORIGINS}, got {for_report_qrels_origin!r}")
    if qrels.provenance.origin != for_report_qrels_origin:
        raise CorpusInputError(
            f"bind_qrels: report would be labelled qrels_origin={for_report_qrels_origin!r}, "
            f"but these qrels are stamped {qrels.provenance.origin!r}"
        )
    known = set(corpus.document_ids)
    for query in qrels.queries:
        if not query.relevant_ids <= known:
            missing = sorted(query.relevant_ids - known)
            raise CorpusInputError(f"query {query.id}: relevant ids not in corpus: {missing}")
    return qrels
