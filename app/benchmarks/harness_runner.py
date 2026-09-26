"""Multi-method benchmark runner for #7: one corpus+qrels, several retrieval
methods, one comparable report -- always alongside a null baseline.

This module runs no retrieval itself. A caller supplies, per method, either
a per-query ranking (or richer per-query status) or a whole-method
`not_run` marker. The runner scores each method with `harness_metrics`,
generates a deterministic null baseline the exact same way, and reports
every method's delta from that null, split by language. It can also fuse
two named methods with RRF and score the fusion as just another method --
which is how this harness can SHOW reciprocal rank fusion losing to its own
components, rather than assume fusion helps.

Per R16/A1, four things this runner refuses to let slip:

* The null baseline is not optional. It is computed and reported for every
  cutoff of every metric, for every language group, for every run, because
  MRR and recall are not interpretable numbers on their own -- a method's
  score means nothing until you know what a corpus this shaped hands to a
  method that isn't looking.
* Summaries are grouped by language (`en`, `th`, `all`) over SEMANTIC
  queries only. A literal probe (Thai inside-word substring check, etc.)
  is reported per query but never folded into a macro mean -- it answers a
  different question (exact-substring behaviour) than MRR/recall do.
* A method, or a single query within a method, can be `complete`, `error`
  or `not_run`. `not_run`'s summary values are `None`, NEVER `0` -- a
  method that did not run said nothing about quality, and `0.0` would read
  as "measured, scored nothing", a different and worse claim. An `error`
  query is preserved and counted, never silently scored as a zero.
* A `manifest` (see `harness_manifest.py`) is REQUIRED and is echoed into
  the report unchanged. `run_benchmark` refuses to run at all if any
  required manifest key is missing -- a report that can't say what engine,
  tokenizer, embedding or artifact digests produced it is not evidence.

Provenance travels with the report untouched (see `harness_corpus.py`): the
output's `provenance.corpus.origin` / `provenance.qrels.origin` are exactly
what the loaders stamped, so an agent-authored run cannot be read downstream
as independently judged.
"""

from __future__ import annotations

import hashlib

from harness_corpus import CORPUS_ORIGINS, QRELS_ORIGINS, Corpus, Qrels
from harness_manifest import validate_manifest
from harness_metrics import fuse_rrf, macro_mean, score_query

__all__ = ["RunnerInputError", "null_ranking", "run_benchmark"]

DEFAULT_CUTOFFS = (1, 5, 10, 20)
NULL_METHOD_NAME = "null_random"
LANGUAGE_GROUPS = ("en", "th", "all")


class RunnerInputError(ValueError):
    """The methods/rankings/manifest supplied to `run_benchmark` are not usable."""


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


def _is_method_not_run(raw_method) -> bool:
    """True when `raw_method` is a whole-method `not_run` marker rather than
    a per-query ranking mapping. A per-query mapping's keys are query ids;
    the marker shape is deliberately narrow (`{"status": "not_run", ...}`
    with only `status`/`reason` keys) so a query id can never collide with
    it in practice."""
    return (
        isinstance(raw_method, dict)
        and raw_method.get("status") == "not_run"
        and set(raw_method.keys()) <= {"status", "reason"}
    )


def _normalize_entry(raw_entry):
    """Turn one method's one query's raw config value into a normalized
    `{"status": ..., ...}` dict. A bare list is shorthand for a complete
    ranking, matching the harness's original (pre-R16) input shape."""
    if isinstance(raw_entry, list):
        return {"status": "complete", "ranking": raw_entry}
    if isinstance(raw_entry, dict) and "status" in raw_entry:
        status = raw_entry["status"]
        if status == "complete":
            if "ranking" not in raw_entry:
                raise RunnerInputError("a 'complete' entry must include 'ranking'")
            return {"status": "complete", "ranking": raw_entry["ranking"]}
        if status == "error":
            return {"status": "error", "code": raw_entry.get("code")}
        if status == "not_run":
            return {"status": "not_run", "reason": raw_entry.get("reason")}
        raise RunnerInputError(f"unknown per-query status: {status!r}")
    raise RunnerInputError(f"unrecognized ranking entry: {raw_entry!r}")


def _entry_for(raw_method, query_id: str):
    """Resolve one query's normalized entry out of a method's raw value,
    whether that value is a whole-method not_run marker or a per-query map."""
    if _is_method_not_run(raw_method):
        return {"status": "not_run", "reason": raw_method.get("reason")}
    if query_id not in raw_method:
        raise RunnerInputError(f"missing ranking for query {query_id!r}")
    return _normalize_entry(raw_method[query_id])


def _is_semantic(query) -> bool:
    """Matches README.md's documented rule exactly: every macro group (en/th/
    all) covers `purpose != "literal"`, not only `purpose == "semantic"`.
    A query with no purpose at all is treated as semantic (the harness's
    original, pre-R16 default). Before this, any OTHER purpose value (e.g.
    "known_item") was silently dropped from every macro group instead of
    being scored -- the code and the documented contract disagreed."""
    return query.purpose != "literal"


def _empty_group_summary(cutoffs) -> dict:
    return {
        "queries": 0,
        "scored": 0,
        "errors": 0,
        "not_run": 0,
        "mrr": None,
        "recall_at_k": {k: None for k in cutoffs},
        "precision_at_k": {k: None for k in cutoffs},
    }


def _group_summary(selected_queries, per_query, cutoffs) -> dict:
    complete = [per_query[q.id] for q in selected_queries if per_query[q.id]["status"] == "complete"]
    errors = sum(1 for q in selected_queries if per_query[q.id]["status"] == "error")
    not_run = sum(1 for q in selected_queries if per_query[q.id]["status"] == "not_run")
    if not complete:
        summary = _empty_group_summary(cutoffs)
        summary["queries"] = len(selected_queries)
        summary["errors"] = errors
        summary["not_run"] = not_run
        return summary
    return {
        "queries": len(selected_queries),
        "scored": len(complete),
        "errors": errors,
        "not_run": not_run,
        "mrr": macro_mean(entry["rr"] for entry in complete),
        "recall_at_k": {k: macro_mean(entry["recall_at_k"][k] for entry in complete) for k in cutoffs},
        "precision_at_k": {k: macro_mean(entry["precision_at_k"][k] for entry in complete) for k in cutoffs},
    }


def _score_method(raw_method, qrels: Qrels, cutoffs) -> dict:
    per_query = {}
    for query in qrels.queries:
        entry = _entry_for(raw_method, query.id)
        if entry["status"] == "complete":
            scored = score_query(entry["ranking"], query.relevant_ids, cutoffs)
            per_query[query.id] = {"status": "complete", **scored}
        elif entry["status"] == "error":
            per_query[query.id] = {"status": "error", "code": entry.get("code")}
        else:
            per_query[query.id] = {"status": "not_run", "reason": entry.get("reason")}

    semantic_queries = [q for q in qrels.queries if _is_semantic(q)]
    summary = {
        "en": _group_summary([q for q in semantic_queries if q.lang == "en"], per_query, cutoffs),
        "th": _group_summary([q for q in semantic_queries if q.lang == "th"], per_query, cutoffs),
        "all": _group_summary(semantic_queries, per_query, cutoffs),
    }
    method_not_run = _is_method_not_run(raw_method)
    result = {"per_query": per_query, "summary": summary, "status": "not_run" if method_not_run else "complete"}
    if method_not_run:
        result["reason"] = raw_method.get("reason")
    return result


def _delta(method_summary, null_summary, cutoffs) -> dict:
    def sub(a, b):
        if a is None or b is None:
            return None
        return a - b

    def group_delta(m, n):
        return {
            "mrr": sub(m["mrr"], n["mrr"]),
            "recall_at_k": {k: sub(m["recall_at_k"][k], n["recall_at_k"][k]) for k in cutoffs},
            "precision_at_k": {k: sub(m["precision_at_k"][k], n["precision_at_k"][k]) for k in cutoffs},
        }

    return {group: group_delta(method_summary[group], null_summary[group]) for group in LANGUAGE_GROUPS}


def _fuse_raw_entry(raw_a, raw_b, query_id: str) -> dict:
    a = _entry_for(raw_a, query_id)
    b = _entry_for(raw_b, query_id)
    if a["status"] == "not_run" or b["status"] == "not_run":
        reason = a.get("reason") if a["status"] == "not_run" else b.get("reason")
        return {"status": "not_run", "reason": reason or "a fused component did not run"}
    if a["status"] == "error" or b["status"] == "error":
        return {"status": "error", "code": "fusion_component_error"}
    return {"status": "complete", "ranking": fuse_rrf(a["ranking"], b["ranking"])}


def run_benchmark(corpus: Corpus, qrels: Qrels, methods: dict, manifest: dict, fuse=(), cutoffs=DEFAULT_CUTOFFS) -> dict:
    """Score every method in `methods` plus a deterministic null baseline,
    grouped by language, and report each method's delta from null.

    `methods` maps `name -> either`:
      - `{query_id: ranking}` (a list is shorthand for a complete ranking;
        a query id may instead map to `{"status": "error", "code": ...}` or
        `{"status": "not_run", "reason": ...}`), or
      - a whole-method marker `{"status": "not_run", "reason": ...}` when
        the method did not run for ANY query (e.g. vector search with no
        frozen vectors supplied).

    `manifest` is REQUIRED and validated with `harness_manifest.validate_manifest`
    before anything else runs -- a missing required key refuses the whole
    call, before any metric is computed.

    `fuse` is an iterable of `(fused_name, method_a, method_b)`: for each
    triple, an RRF-fused ranking is built per query from `methods[method_a]`
    and `methods[method_b]` and scored as an ordinary additional method
    named `fused_name`. If either component did not run/errored for a
    query, the fused entry for that query carries the same status rather
    than silently fusing a partial ranking.

    Requires `corpus` and `qrels` to already be `bind_qrels`-checked (same
    provenance origin as the report will claim, every relevant id present
    in the corpus); this function does not re-validate that pairing.

    `corpus.provenance.origin` and `qrels.provenance.origin` ARE checked
    against `CORPUS_ORIGINS`/`QRELS_ORIGINS` here, even though `bind_qrels`
    checks them too -- `Corpus`/`Qrels`/`*Provenance` are public dataclasses,
    so a caller can build one directly instead of going through a loader,
    bypassing `bind_qrels` entirely. This is the last place a forged or
    mistyped origin can be refused before it reaches a report.
    """
    validate_manifest(manifest)

    if corpus.provenance.origin not in CORPUS_ORIGINS:
        raise RunnerInputError(f"corpus.provenance.origin must be one of {CORPUS_ORIGINS}, got {corpus.provenance.origin!r}")
    if qrels.provenance.origin not in QRELS_ORIGINS:
        raise RunnerInputError(f"qrels.provenance.origin must be one of {QRELS_ORIGINS}, got {qrels.provenance.origin!r}")

    if not methods:
        raise RunnerInputError("run_benchmark requires at least one method")
    if NULL_METHOD_NAME in methods:
        raise RunnerInputError(f"method name {NULL_METHOD_NAME!r} is reserved for the null baseline")

    all_rankings: dict = dict(methods)
    for fused_name, method_a, method_b in fuse:
        if fused_name in all_rankings:
            raise RunnerInputError(f"fused method name {fused_name!r} collides with an existing method")
        if method_a not in methods or method_b not in methods:
            raise RunnerInputError(f"fuse triple references an unknown method: {method_a!r}, {method_b!r}")
        all_rankings[fused_name] = {
            query.id: _fuse_raw_entry(methods[method_a], methods[method_b], query.id) for query in qrels.queries
        }

    null_rankings = {query.id: null_ranking(corpus, query.id) for query in qrels.queries}
    null_result = _score_method(null_rankings, qrels, cutoffs)

    method_results = {}
    for name, raw_method in all_rankings.items():
        result = _score_method(raw_method, qrels, cutoffs)
        result["delta_from_null"] = _delta(result["summary"], null_result["summary"], cutoffs)
        method_results[name] = result

    return {
        "version": "arra-benchmark-report/v2",
        "provenance": {
            "corpus": {
                "origin": corpus.provenance.origin,
                "label": corpus.provenance.label,
                "source": corpus.provenance.source,
                "created": corpus.provenance.created,
            },
            "qrels": {
                "origin": qrels.provenance.origin,
                "held_out": qrels.provenance.held_out,
                "label": qrels.provenance.label,
                "source": qrels.provenance.source,
                "created": qrels.provenance.created,
            },
        },
        "corpus_size": len(corpus.document_ids),
        "queries": len(qrels.queries),
        "cutoffs": list(cutoffs),
        "manifest": manifest,
        "methods": method_results,
        NULL_METHOD_NAME: null_result,
    }
