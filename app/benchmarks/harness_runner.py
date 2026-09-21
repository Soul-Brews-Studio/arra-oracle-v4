"""Multi-method benchmark runner for #7: one corpus+qrels, several retrieval
methods, one comparable report -- always alongside a null baseline.

This module runs no retrieval itself. A caller supplies, per method, a
ranking (a list of document ids) already produced for every query; the
runner scores each method with `harness_metrics`, generates a deterministic
null baseline the exact same way, and reports every method's delta from that
null. It can also fuse two named methods with RRF and score the fusion as
just another method -- which is how this harness can SHOW reciprocal rank
fusion losing to its own components, rather than assume fusion helps.

Three things this runner refuses to let slip:

* The null baseline is not optional. It is computed and reported for every
  cutoff of every metric, for every run, because MRR and recall are not
  interpretable numbers on their own -- a method's score means nothing until
  you know what a corpus this shaped hands to a method that isn't looking.
* Provenance travels with the report untouched (see `harness_corpus.py`):
  the output's `provenance.kind` is exactly what the loader stamped, so a
  synthetic run cannot be read downstream as a held-out result.
* A method missing a ranking for any query in the qrels is a configuration
  error, refused before any metric is computed -- silently treating a
  missing query as a zero would hide the difference between "did not answer"
  and "answered with nothing" (an explicit `[]` ranking is a real, scored
  zero).
"""

from __future__ import annotations

import hashlib

from harness_corpus import Corpus, Qrels
from harness_metrics import fuse_rrf, macro_mean, score_query

__all__ = ["RunnerInputError", "null_ranking", "run_benchmark"]

DEFAULT_CUTOFFS = (1, 5, 10, 20)
NULL_METHOD_NAME = "null_random"


class RunnerInputError(ValueError):
    """The methods/rankings supplied to `run_benchmark` are not usable."""


def null_ranking(corpus: Corpus, query_id: str):
    """A deterministic pseudo-random ranking of the whole corpus for one query.

    Deterministic, not truly random: the order is a stable sort of the corpus
    by `sha256(query_id + document_id)`. Same inputs always produce the same
    ranking, so the null baseline is reproducible across runs -- a rerun of
    this harness against the same corpus+qrels must reproduce the same null
    score, or the "null" would itself be a source of noise in the comparison.
    """

    def key(document_id: str) -> bytes:
        return hashlib.sha256(f"{query_id}\0{document_id}".encode("utf-8")).digest()

    return sorted(corpus.document_ids, key=key)


def _score_method(ranking_by_query, qrels: Qrels, cutoffs):
    per_query = {}
    for query in qrels.queries:
        if query.id not in ranking_by_query:
            raise RunnerInputError(f"missing ranking for query {query.id!r}")
        per_query[query.id] = score_query(ranking_by_query[query.id], query.relevant_ids, cutoffs)

    summary = {
        "queries": len(qrels.queries),
        "mrr": macro_mean(entry["rr"] for entry in per_query.values()),
        "recall_at_k": {
            k: macro_mean(entry["recall_at_k"][k] for entry in per_query.values()) for k in cutoffs
        },
        "precision_at_k": {
            k: macro_mean(entry["precision_at_k"][k] for entry in per_query.values()) for k in cutoffs
        },
    }
    return {"per_query": per_query, "summary": summary}


def _delta(method_summary, null_summary, cutoffs):
    def sub(a, b):
        if a is None or b is None:
            return None
        return a - b

    return {
        "mrr": sub(method_summary["mrr"], null_summary["mrr"]),
        "recall_at_k": {k: sub(method_summary["recall_at_k"][k], null_summary["recall_at_k"][k]) for k in cutoffs},
        "precision_at_k": {
            k: sub(method_summary["precision_at_k"][k], null_summary["precision_at_k"][k]) for k in cutoffs
        },
    }


def run_benchmark(corpus: Corpus, qrels: Qrels, methods: dict, fuse=(), cutoffs=DEFAULT_CUTOFFS) -> dict:
    """Score every method in `methods` (name -> {query_id: ranking}) plus a
    deterministic null baseline, and report each method's delta from null.

    `fuse` is an iterable of `(fused_name, method_a, method_b)`: for each
    triple, an RRF-fused ranking is built per query from `methods[method_a]`
    and `methods[method_b]` and scored as an ordinary additional method named
    `fused_name`. This is how a candidate fusion method is put on equal
    footing with its inputs, rather than assumed to win.

    Requires `corpus` and `qrels` to already be `bind_qrels`-checked (same
    provenance kind, every relevant id present in the corpus); this function
    does not re-validate that pairing.
    """
    if not methods:
        raise RunnerInputError("run_benchmark requires at least one method")
    if NULL_METHOD_NAME in methods:
        raise RunnerInputError(f"method name {NULL_METHOD_NAME!r} is reserved for the null baseline")

    all_rankings = dict(methods)
    for fused_name, method_a, method_b in fuse:
        if fused_name in all_rankings:
            raise RunnerInputError(f"fused method name {fused_name!r} collides with an existing method")
        if method_a not in methods or method_b not in methods:
            raise RunnerInputError(f"fuse triple references an unknown method: {method_a!r}, {method_b!r}")
        all_rankings[fused_name] = {
            query.id: fuse_rrf(methods[method_a][query.id], methods[method_b][query.id])
            for query in qrels.queries
        }

    null_rankings = {query.id: null_ranking(corpus, query.id) for query in qrels.queries}
    null_result = _score_method(null_rankings, qrels, cutoffs)

    method_results = {}
    for name, ranking_by_query in all_rankings.items():
        result = _score_method(ranking_by_query, qrels, cutoffs)
        result["delta_from_null"] = _delta(result["summary"], null_result["summary"], cutoffs)
        method_results[name] = result

    return {
        "version": "arra-benchmark-report/v1",
        "provenance": {
            "kind": corpus.provenance.kind,
            "label": corpus.provenance.label,
            "source": corpus.provenance.source,
            "created": corpus.provenance.created,
        },
        "corpus_size": len(corpus.document_ids),
        "queries": len(qrels.queries),
        "cutoffs": list(cutoffs),
        "methods": method_results,
        NULL_METHOD_NAME: null_result,
    }
