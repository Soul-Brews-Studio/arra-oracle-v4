"""Method-agnostic retrieval metrics for the #7 benchmark harness.

`retrieval_metrics.py` (#52) scores one frozen three-profile dispatch document
(icu/trigram/vector) and does not expose precision@k. This module is the
pluggable building block #7 also needs: MRR, recall@k and precision@k for
however many methods a harness run produces, at whatever cutoffs it asks for,
including a null baseline scored the exact same way as every real method.

Standard library only. No I/O, no model, no index.
"""

from __future__ import annotations

import math
from fractions import Fraction

__all__ = [
    "reciprocal_rank",
    "recall_at_k",
    "precision_at_k",
    "score_query",
    "macro_mean",
    "fuse_rrf",
]

RRF_K = 60


def reciprocal_rank(ranking, relevant) -> Fraction:
    """1 / rank of the first relevant id, over the FULL ranking. 0 if none."""
    for position, document_id in enumerate(ranking, start=1):
        if document_id in relevant:
            return Fraction(1, position)
    return Fraction(0)


def recall_at_k(ranking, relevant, k: int) -> Fraction:
    """Fraction of a query's relevant ids that appear in the first k results.

    Empty `relevant` is a caller error (a query with no relevant document is
    not a measurement), not a silent 0/0 -> 0.
    """
    if not relevant:
        raise ValueError("recall_at_k requires at least one relevant id")
    found = sum(1 for document_id in ranking[:k] if document_id in relevant)
    return Fraction(found, len(relevant))


def precision_at_k(ranking, relevant, k: int) -> Fraction:
    """Fraction of the top-k results that are relevant.

    Denominator is always k, even when the ranking is shorter than k (missing
    slots count against precision, they are not skipped) and even when k
    exceeds the corpus size for this query -- that is a real, if unflattering,
    measurement, not an error.
    """
    if k <= 0:
        raise ValueError("precision_at_k requires k >= 1")
    found = sum(1 for document_id in ranking[:k] if document_id in relevant)
    return Fraction(found, k)


def score_query(ranking, relevant, cutoffs) -> dict:
    """RR plus recall@k/precision@k at every cutoff in `cutoffs`, as floats."""
    return {
        "rr": float(reciprocal_rank(ranking, relevant)),
        "recall_at_k": {k: float(recall_at_k(ranking, relevant, k)) for k in cutoffs},
        "precision_at_k": {k: float(precision_at_k(ranking, relevant, k)) for k in cutoffs},
    }


def macro_mean(values):
    """Mean weighted by QUERY, not by how many relevant ids a query has.

    `None` for an empty group -- a group with no queries has no mean, and
    reporting 0.0 would read as "measured, scored nothing", which is a
    different and worse claim than "not measured".
    """
    values = list(values)
    if not values:
        return None
    return math.fsum(values) / len(values)


def _utf16_order(text: str) -> bytes:
    """Sort key giving JavaScript string order, matching retrieval_metrics.py."""
    return text.encode("utf-16-be")


def fuse_rrf(first, second, k: int = RRF_K):
    """Reciprocal rank fusion at cutoff k over two rankings for ONE query.

    Sums 1/(k+rank) per ranking for every id that actually appears; an id
    absent from a ranking contributes nothing, it is never given an invented
    rank. Exact `Fraction` arithmetic so ties are ties, not float noise; ties
    break on UTF-16 code units, matching retrieval_metrics.py's fusion.
    """
    scores: dict[str, Fraction] = {}
    for ranking in (first, second):
        for position, document_id in enumerate(ranking, start=1):
            scores[document_id] = scores.get(document_id, Fraction(0)) + Fraction(1, k + position)
    return [
        document_id
        for document_id, _ in sorted(scores.items(), key=lambda item: (-item[1], _utf16_order(item[0])))
    ]
