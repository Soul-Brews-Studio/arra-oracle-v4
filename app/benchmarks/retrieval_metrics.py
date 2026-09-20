"""Offline retrieval metrics for #7, standard library only.

This module MEASURES a document that someone else produced. It runs no model,
opens no index, issues no query and reaches no network. Given the same bytes it
returns the same result, which is the whole reason it exists: a number nobody
can reproduce is not evidence.

What it computes, exactly as the frozen #52 dispatch defines it:

* reciprocal rank — 1 / the rank of the first relevant document, over the FULL
  ranking, 1-based, zero when none is found. Deliberately NOT truncated at the
  cutoff: a hit at rank 21 is worse than one at rank 1 and better than none,
  and truncating would report those last two as the same thing.
* recall@20 — how many of a query's relevant documents appear in the first 20,
  divided by how many it has.
* two derived fusions — reciprocal rank fusion at k=60 over (icu, vector) and
  (trigram, vector), summing 1/(60+rank) for every id that actually appears.
  An id absent from a ranking contributes nothing; it is never given an
  invented rank at the end.

Three decisions worth stating, because each one is a trap avoided rather than
an obvious default:

* **Fusion scores are exact rationals.** `Fraction`, not float. Two ids can tie
  at exactly 1/61, and float arithmetic would sometimes separate them by one
  ulp and produce an order that depends on accumulation order.
* **Ties break on UTF-16 code units**, matching JavaScript string order, not
  Python's native codepoint order. The two disagree for supplementary
  characters, which encode as surrogate pairs that sort BELOW U+E000..U+FFFF in
  UTF-16 and above them by codepoint. Comparing UTF-16-BE bytes is exactly a
  comparison of 16-bit code units.
* **An empty group yields null, never zero.** A language with no semantic
  queries has no mean. Reporting 0.0 would read as "measured, scored nothing",
  which is a different and much worse claim than "not measured".

Scope limits, stated as limits. `provenance.held_out` is a CALLER DECLARATION.
Nothing here can verify it, so every result records
`provenance_verification: "not_verified"` whatever the caller claimed. An
incomplete run is refused outright rather than scored as a zero, because a
profile that failed to answer and a profile that answered with nothing are not
the same measurement. And none of this says any retrieval profile is good: that
needs a provenance-approved held-out corpus and a real retrieval run, neither of
which is in this file.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from fractions import Fraction

__all__ = ["BenchmarkInputError", "evaluate", "main"]

INPUT_VERSION = "arra-retrieval-eval/v1"
OUTPUT_VERSION = "arra-retrieval-metrics/v1"

MAX_INPUT_BYTES = 16 * 1024 * 1024
CUTOFF = 20
RRF_K = 60

RUN_PROFILES = ("icu", "trigram", "vector")
DERIVED_PROFILES = (
    ("rrf_icu_vector", "icu", "vector"),
    ("rrf_trigram_vector", "trigram", "vector"),
)
LANGUAGES = ("en", "th")
PURPOSES = ("semantic", "literal")
SUMMARY_GROUPS = ("all", *LANGUAGES)

CLI_ERROR_MESSAGE = "invalid benchmark input"


class BenchmarkInputError(ValueError):
    """The document is not one this evaluator will score.

    Carries no detail from the input on purpose: the CLI prints one fixed line,
    so a rejected document cannot leak a fragment of itself through an error.
    """


def _reject() -> BenchmarkInputError:
    return BenchmarkInputError(CLI_ERROR_MESSAGE)


# ── document grammar ────────────────────────────────────────────────────────


def _no_duplicate_keys(pairs):
    seen = set()
    for key, _ in pairs:
        if key in seen:
            # A duplicate key means two documents disagree about one field and
            # the parser would silently pick the last. Refuse instead.
            raise _reject()
        seen.add(key)
    return dict(pairs)


def _no_constants(_literal):
    # NaN and Infinity are not JSON, and a metric document must not carry a
    # value that compares false with itself.
    raise _reject()


def _text(value) -> str:
    """A non-empty string that is real Unicode, not a lone surrogate."""
    if not isinstance(value, str) or not value:
        raise _reject()
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        # Reached via a \uD800-style escape: the bytes decoded fine, but the
        # resulting string is not encodable text.
        raise _reject() from None
    return value


def _boolean(value) -> bool:
    if not isinstance(value, bool):
        raise _reject()
    return value


def _closed(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise _reject()
    return value


def _array(value):
    if not isinstance(value, list):
        raise _reject()
    return value


def _enumerated(value, allowed) -> str:
    text = _text(value)
    if text not in allowed:
        raise _reject()
    return text


def _parse(document_bytes) -> dict:
    if not isinstance(document_bytes, (bytes, bytearray)):
        raise _reject()
    if len(document_bytes) > MAX_INPUT_BYTES:
        raise _reject()
    try:
        text = bytes(document_bytes).decode("utf-8")
    except UnicodeDecodeError:
        raise _reject() from None
    try:
        parsed = json.loads(
            text, object_pairs_hook=_no_duplicate_keys, parse_constant=_no_constants
        )
    except ValueError:
        raise _reject() from None
    except RecursionError:
        # CPython's JSON parser recurses per nesting level, so a document that
        # is small in bytes can still exhaust the stack -- measured, roughly
        # 20 KB of nested brackets does it on 3.12.13, far below the 16 MiB
        # cap. That is a malformed input for this evaluator's purposes and must
        # arrive as one, not as a traceback escaping through the CLI.
        #
        # Deliberately NOT a depth limit: the dispatch's grammar has no nesting
        # depth restriction, and inventing one here would reject schema-valid
        # documents that the parser handles perfectly well.
        raise _reject() from None
    if not isinstance(parsed, dict):
        raise _reject()
    return parsed


def _validate(parsed: dict):
    """Return (provenance, corpus_ids, queries, runs) or raise."""
    _closed(parsed, ("version", "provenance", "corpus", "queries", "runs"))
    if parsed["version"] != INPUT_VERSION:
        raise _reject()

    raw_provenance = _closed(parsed["provenance"], ("label", "held_out"))
    provenance = {
        "label": _text(raw_provenance["label"]),
        "held_out": _boolean(raw_provenance["held_out"]),
    }

    corpus_entries = _array(parsed["corpus"])
    if not corpus_entries:
        raise _reject()
    corpus_ids = []
    for entry in corpus_entries:
        corpus_ids.append(_text(_closed(entry, ("id",))["id"]))
    corpus = set(corpus_ids)
    if len(corpus) != len(corpus_ids):
        raise _reject()

    query_entries = _array(parsed["queries"])
    if not query_entries:
        raise _reject()
    queries = []
    for entry in query_entries:
        fields = _closed(entry, ("id", "lang", "purpose", "relevant_ids"))
        relevant = [_text(value) for value in _array(fields["relevant_ids"])]
        if not relevant or len(set(relevant)) != len(relevant):
            raise _reject()
        if not set(relevant) <= corpus:
            raise _reject()
        queries.append(
            {
                "id": _text(fields["id"]),
                "lang": _enumerated(fields["lang"], LANGUAGES),
                "purpose": _enumerated(fields["purpose"], PURPOSES),
                "relevant": frozenset(relevant),
                "relevant_count": len(relevant),
            }
        )
    query_ids = [query["id"] for query in queries]
    if len(set(query_ids)) != len(query_ids):
        raise _reject()

    raw_runs = _closed(parsed["runs"], RUN_PROFILES)
    runs = {}
    for profile in RUN_PROFILES:
        rankings = {}
        for entry in _array(raw_runs[profile]):
            fields = _closed(entry, ("query_id", "status", "ranking"))
            query_id = _text(fields["query_id"])
            if query_id in rankings:
                raise _reject()
            # An incomplete run is refused, never scored: "did not answer" and
            # "answered with nothing" are different measurements.
            if fields["status"] != "complete":
                raise _reject()
            ranking = [_text(value) for value in _array(fields["ranking"])]
            if len(set(ranking)) != len(ranking) or not set(ranking) <= corpus:
                raise _reject()
            rankings[query_id] = ranking
        # Exactly one entry per query: no missing, extra or duplicate.
        if set(rankings) != set(query_ids):
            raise _reject()
        runs[profile] = rankings

    return provenance, queries, runs


# ── metrics ─────────────────────────────────────────────────────────────────


def _reciprocal_rank(ranking, relevant) -> Fraction:
    for position, document_id in enumerate(ranking, start=1):
        if document_id in relevant:
            return Fraction(1, position)
    return Fraction(0)


def _recall_at_cutoff(ranking, query) -> Fraction:
    found = sum(1 for document_id in ranking[:CUTOFF] if document_id in query["relevant"])
    return Fraction(found, query["relevant_count"])


def _utf16_order(text: str) -> bytes:
    """Sort key giving JavaScript string order, not Python codepoint order."""
    return text.encode("utf-16-be")


def _fuse(first, second):
    scores: dict[str, Fraction] = {}
    for ranking in (first, second):
        for position, document_id in enumerate(ranking, start=1):
            scores[document_id] = scores.get(document_id, Fraction(0)) + Fraction(
                1, RRF_K + position
            )
    return [
        document_id
        for document_id, _ in sorted(
            scores.items(), key=lambda item: (-item[1], _utf16_order(item[0]))
        )
    ]


def _summarise(queries, per_query):
    summary = {}
    for group in SUMMARY_GROUPS:
        # Literal probes are reported per query but never aggregated: they
        # exist to check exact-substring behaviour, not semantic quality.
        chosen = [
            query
            for query in queries
            if query["purpose"] == "semantic" and (group == "all" or query["lang"] == group)
        ]
        if not chosen:
            summary[group] = {"queries": 0, "mrr": None, "macro_recall_at_20": None}
            continue
        count = len(chosen)
        ranks = [per_query[query["id"]]["rr"] for query in chosen]
        recalls = [per_query[query["id"]]["recall_at_20"] for query in chosen]
        # Macro by QUERY: every query weighs the same regardless of how many
        # relevant documents it has. A micro mean would let one query with many
        # relevant documents dominate the score.
        summary[group] = {
            "queries": count,
            "mrr": math.fsum(ranks) / count,
            "macro_recall_at_20": math.fsum(recalls) / count,
        }
    return summary


def _profile(queries, rankings):
    per_query = {}
    for query in queries:
        ranking = rankings[query["id"]]
        per_query[query["id"]] = {
            "rr": float(_reciprocal_rank(ranking, query["relevant"])),
            "recall_at_20": float(_recall_at_cutoff(ranking, query)),
        }
    return {
        # Query order follows the INPUT queries array, never the order the run
        # entries happened to be listed in.
        "rankings": {query["id"]: list(rankings[query["id"]]) for query in queries},
        "per_query": per_query,
        "summary": _summarise(queries, per_query),
    }


def evaluate(document_bytes: bytes) -> dict:
    """Score one evaluation document. Raises `BenchmarkInputError` if invalid."""
    parsed = _parse(document_bytes)
    provenance, queries, runs = _validate(parsed)

    rankings_by_profile = dict(runs)
    for name, first, second in DERIVED_PROFILES:
        rankings_by_profile[name] = {
            query["id"]: _fuse(runs[first][query["id"]], runs[second][query["id"]])
            for query in queries
        }

    profiles = {
        name: _profile(queries, rankings_by_profile[name])
        for name in (*RUN_PROFILES, *(entry[0] for entry in DERIVED_PROFILES))
    }

    return {
        "version": OUTPUT_VERSION,
        "input_sha256": hashlib.sha256(bytes(document_bytes)).hexdigest(),
        "provenance": provenance,
        # Echoing a claim is not checking it. This field says so in the result
        # itself, so a downstream reader cannot mistake acceptance for proof.
        "provenance_verification": "not_verified",
        "cutoff": CUTOFF,
        "rrf_k": RRF_K,
        "profiles": profiles,
    }


def main(argv=None) -> int:
    """Read one document, write one JSON result to stdout. No file is written."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(arguments) != 1:
            raise _reject()
        with open(arguments[0], "rb") as handle:
            # Read at most one byte past the accepted cap: enough to know the
            # file is too large, without pulling an arbitrarily large file into
            # memory just to reject it.
            raw = handle.read(MAX_INPUT_BYTES + 1)
        result = evaluate(raw)
    except (BenchmarkInputError, OSError):
        # One fixed line, never the parser's complaint and never a fragment of
        # the document, so a rejection cannot echo the input back.
        sys.stderr.write(f"{CLI_ERROR_MESSAGE}\n")
        return 1
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
