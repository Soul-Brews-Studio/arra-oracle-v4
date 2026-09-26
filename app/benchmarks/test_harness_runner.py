"""Tests for harness_runner.py (#7, R16/A1): the multi-method comparable report.

What these prove: every run reports a null baseline for every metric at
every cutoff, split by language (en/th/all) over SEMANTIC queries only
(literal probes are excluded from every group but kept per query); every
method (including an RRF fusion candidate) is scored the exact same way so
methods are comparable; `delta_from_null` is computed per group;
provenance passes through untouched; a `not_run` method reports `None`
summaries (never `0`), a per-query `error` is preserved and counted rather
than scored as zero; and `run_benchmark` refuses to run at all when the
required `manifest` is missing a key.

Nothing here claims a retrieval method is good: the corpus below is a tiny
hand-authored fixture, not a held-out corpus, and is used only to exercise
the runner's bookkeeping.

Run explicitly (outside any discovery root this repo uses):

    cd app/benchmarks
    python -W error::ResourceWarning test_harness_runner.py -v
"""

import json
import unittest
from fractions import Fraction
from pathlib import Path

from harness_corpus import bind_qrels, load_agent_authored_corpus, load_agent_authored_qrels
from harness_manifest import ManifestInputError
from harness_runner import NULL_METHOD_NAME, RunnerInputError, null_ranking, run_benchmark

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "harness-v1" / "synthetic-example.json"


def toy_corpus():
    return load_agent_authored_corpus({
        "provenance": {"label": "toy", "source": "hand-authored", "created": "2026-09-21"},
        "documents": [
            {"id": "c1", "title": "t1", "type": "note", "body": "b1", "lang": "en"},
            {"id": "c2", "title": "t2", "type": "note", "body": "b2", "lang": "en"},
            {"id": "c3", "title": "t3", "type": "note", "body": "b3", "lang": "th"},
            {"id": "c4", "title": "t4", "type": "note", "body": "b4", "lang": "th"},
            {"id": "c5", "title": "t5", "type": "note", "body": "b5", "lang": "en"},
        ],
    })


def toy_qrels(queries):
    qrels = load_agent_authored_qrels({
        "provenance": {"label": "toy", "source": "hand-authored", "created": "2026-09-21"},
        "queries": queries,
    }, held_out=False)
    return bind_qrels(toy_corpus(), qrels, for_report_qrels_origin="agent_authored")


def bilingual_qrels():
    return toy_qrels([
        {"id": "q1", "relevant_ids": ["c1"], "lang": "en", "purpose": "semantic"},
        {"id": "q2", "relevant_ids": ["c2"], "lang": "en", "purpose": "semantic"},
    ])


def toy_methods():
    return {
        "fts": {"q1": ["c1", "c2", "c3", "c4", "c5"], "q2": ["c1", "c2", "c3", "c4", "c5"]},
        "vector": {"q1": ["c4", "c5", "c1", "c2", "c3"], "q2": ["c4", "c5", "c2", "c1", "c3"]},
    }


def full_manifest(**overrides):
    manifest = {
        "engine": {"@lancedb/lancedb": "0.38.0", "apache-arrow": "18.1.0"},
        "tokenizers": {"icu": {"base_tokenizer": "icu"}, "ngram3": {"base_tokenizer": "ngram"}},
        "indexed_text_composition": "${title}\n\n${body}",
        "candidate_limit": 5,
        "eligibility_filter": "none (single-workspace fixture)",
        "embedding": {"status": "not_run", "model": None, "ollama_digest": None, "dims": None, "distance": None, "normalization": None},
        "artifact_sha256": {"corpus": "a" * 64, "queries": "b" * 64, "qrels": "c" * 64, "vectors": None},
        "rrf": {"k": 60, "tie_rule": "utf16_code_unit"},
    }
    manifest.update(overrides)
    return manifest


class NullRankingTests(unittest.TestCase):
    def test_deterministic_across_calls(self):
        corpus = toy_corpus()
        first = null_ranking(corpus, "q1")
        second = null_ranking(corpus, "q1")
        self.assertEqual(first, second)

    def test_covers_the_whole_corpus_exactly_once(self):
        corpus = toy_corpus()
        ranking = null_ranking(corpus, "q1")
        self.assertEqual(set(ranking), set(corpus.document_ids))
        self.assertEqual(len(ranking), len(corpus.document_ids))

    def test_different_queries_can_get_different_orders(self):
        corpus = toy_corpus()
        self.assertNotEqual(null_ranking(corpus, "q1"), null_ranking(corpus, "q2"))


class ManifestGateTests(unittest.TestCase):
    def test_missing_manifest_key_refuses_the_whole_run(self):
        manifest = full_manifest()
        del manifest["rrf"]
        with self.assertRaises(ManifestInputError):
            run_benchmark(toy_corpus(), bilingual_qrels(), toy_methods(), manifest)

    def test_full_manifest_is_echoed_into_the_report_unchanged(self):
        manifest = full_manifest()
        report = run_benchmark(toy_corpus(), bilingual_qrels(), toy_methods(), manifest)
        self.assertEqual(report["manifest"], manifest)


class RunBenchmarkStructureTests(unittest.TestCase):
    def setUp(self):
        self.corpus = toy_corpus()
        self.qrels = bilingual_qrels()
        self.report = run_benchmark(
            self.corpus, self.qrels, toy_methods(), full_manifest(),
            fuse=[("rrf_fts_vector", "fts", "vector")],
            cutoffs=(1, 5),
        )

    def test_provenance_passes_through_untouched(self):
        self.assertEqual(self.report["provenance"]["corpus"]["origin"], "agent_authored")
        self.assertEqual(self.report["provenance"]["qrels"]["origin"], "agent_authored")
        self.assertEqual(self.report["provenance"]["corpus"]["label"], "toy")

    def test_every_supplied_method_and_the_fusion_are_present(self):
        self.assertEqual(set(self.report["methods"]), {"fts", "vector", "rrf_fts_vector"})

    def test_null_baseline_is_a_top_level_sibling_not_a_method(self):
        self.assertIn(NULL_METHOD_NAME, self.report)
        self.assertNotIn(NULL_METHOD_NAME, self.report["methods"])

    def test_summaries_are_grouped_by_language(self):
        null_summary = self.report[NULL_METHOD_NAME]["summary"]
        self.assertEqual(set(null_summary), {"en", "th", "all"})
        self.assertEqual(set(null_summary["en"]["recall_at_k"]), {1, 5})

    def test_all_group_counts_both_semantic_queries(self):
        fts_summary = self.report["methods"]["fts"]["summary"]
        self.assertEqual(fts_summary["all"]["queries"], 2)
        self.assertEqual(fts_summary["en"]["queries"], 2)
        self.assertEqual(fts_summary["th"]["queries"], 0)
        self.assertIsNone(fts_summary["th"]["mrr"])  # empty group -> None, never 0

    def test_delta_from_null_present_for_every_method_group_and_metric(self):
        for name in ("fts", "vector", "rrf_fts_vector"):
            delta = self.report["methods"][name]["delta_from_null"]
            self.assertEqual(set(delta), {"en", "th", "all"})
            self.assertIn("mrr", delta["all"])
            self.assertEqual(set(delta["all"]["recall_at_k"]), {1, 5})

    def test_delta_from_null_is_exactly_method_minus_null(self):
        null_mrr = self.report[NULL_METHOD_NAME]["summary"]["all"]["mrr"]
        fts_mrr = self.report["methods"]["fts"]["summary"]["all"]["mrr"]
        fts_delta = self.report["methods"]["fts"]["delta_from_null"]["all"]["mrr"]
        self.assertAlmostEqual(fts_delta, fts_mrr - null_mrr)

    def test_fts_beats_vector_on_this_fixture_and_the_report_shows_it_per_method(self):
        fts_mrr = self.report["methods"]["fts"]["summary"]["all"]["mrr"]
        vector_mrr = self.report["methods"]["vector"]["summary"]["all"]["mrr"]
        rrf_mrr = self.report["methods"]["rrf_fts_vector"]["summary"]["all"]["mrr"]
        self.assertEqual(fts_mrr, 0.75)
        self.assertAlmostEqual(vector_mrr, float(Fraction(1, 3)))
        self.assertGreater(fts_mrr, vector_mrr)
        self.assertLess(rrf_mrr, fts_mrr)


class LiteralProbeExclusionTests(unittest.TestCase):
    def test_literal_probe_excluded_from_every_group_but_kept_per_query(self):
        qrels = toy_qrels([
            {"id": "q1", "relevant_ids": ["c1"], "lang": "en", "purpose": "semantic"},
            {"id": "qlit", "relevant_ids": ["c3"], "lang": "th", "purpose": "literal"},
        ])
        report = run_benchmark(toy_corpus(), qrels, {
            "fts": {"q1": ["c1"], "qlit": ["c3"]},
        }, full_manifest())
        fts = report["methods"]["fts"]
        self.assertIn("qlit", fts["per_query"])  # kept per query
        self.assertEqual(fts["summary"]["all"]["queries"], 1)  # excluded from every group
        self.assertEqual(fts["summary"]["th"]["queries"], 0)


class NotRunAndErrorStatusTests(unittest.TestCase):
    def test_whole_method_not_run_reports_none_not_zero(self):
        qrels = bilingual_qrels()
        report = run_benchmark(toy_corpus(), qrels, {
            "fts": toy_methods()["fts"],
            "vector": {"status": "not_run", "reason": "no frozen vectors"},
        }, full_manifest())
        vector = report["methods"]["vector"]
        self.assertEqual(vector["status"], "not_run")
        self.assertEqual(vector["reason"], "no frozen vectors")
        self.assertIsNone(vector["summary"]["all"]["mrr"])
        self.assertIsNone(vector["delta_from_null"]["all"]["mrr"])
        for query_id in ("q1", "q2"):
            self.assertEqual(vector["per_query"][query_id]["status"], "not_run")

    def test_per_query_error_is_preserved_and_not_scored_as_zero(self):
        qrels = bilingual_qrels()
        report = run_benchmark(toy_corpus(), qrels, {
            "fts": {"q1": ["c1", "c2"], "q2": {"status": "error", "code": "timeout"}},
        }, full_manifest())
        fts = report["methods"]["fts"]
        self.assertEqual(fts["per_query"]["q2"], {"status": "error", "code": "timeout"})
        # Only q1 (the complete one) is scored; q2 is counted as an error, not a zero.
        self.assertEqual(fts["summary"]["all"]["scored"], 1)
        self.assertEqual(fts["summary"]["all"]["errors"], 1)
        self.assertEqual(fts["summary"]["all"]["mrr"], 1.0)  # q1 hits at rank 1; q2 excluded, not averaged as 0

    def test_fusion_with_a_not_run_component_is_not_run_not_fused_from_partial_data(self):
        qrels = bilingual_qrels()
        report = run_benchmark(toy_corpus(), qrels, {
            "fts": toy_methods()["fts"],
            "vector": {"status": "not_run", "reason": "no frozen vectors"},
        }, full_manifest(), fuse=[("rrf_fts_vector", "fts", "vector")])
        fused = report["methods"]["rrf_fts_vector"]
        for query_id in ("q1", "q2"):
            self.assertEqual(fused["per_query"][query_id]["status"], "not_run")
        self.assertIsNone(fused["summary"]["all"]["mrr"])


class RunBenchmarkGuardTests(unittest.TestCase):
    def test_missing_ranking_for_a_query_is_refused(self):
        methods = toy_methods()
        del methods["vector"]["q2"]
        with self.assertRaises(RunnerInputError):
            run_benchmark(toy_corpus(), bilingual_qrels(), methods, full_manifest())

    def test_reserved_null_method_name_is_refused(self):
        methods = toy_methods()
        methods[NULL_METHOD_NAME] = methods["fts"]
        with self.assertRaises(RunnerInputError):
            run_benchmark(toy_corpus(), bilingual_qrels(), methods, full_manifest())

    def test_fuse_referencing_unknown_method_is_refused(self):
        with self.assertRaises(RunnerInputError):
            run_benchmark(toy_corpus(), bilingual_qrels(), toy_methods(), full_manifest(), fuse=[("rrf", "fts", "missing")])

    def test_no_methods_is_refused(self):
        with self.assertRaises(RunnerInputError):
            run_benchmark(toy_corpus(), bilingual_qrels(), {}, full_manifest())


class SyntheticFixtureEndToEndTest(unittest.TestCase):
    """Loads fixtures/harness-v1/synthetic-example.json through the real
    loader-to-runner path, proving the pieces wire together end to end and
    that the fixture's own JSON stays labelled synthetic (corpus) /
    agent_authored (qrels) -- never anything stronger."""

    def test_fixture_runs_and_stays_labelled_synthetic(self):
        from harness_corpus import load_synthetic_corpus

        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        corpus = load_synthetic_corpus(data["corpus"])
        qrels = bind_qrels(
            corpus,
            load_agent_authored_qrels(data["qrels"], held_out=False),
            for_report_qrels_origin="agent_authored",
        )
        report = run_benchmark(corpus, qrels, data["methods"], full_manifest(), fuse=[tuple(data["fuse"][0])])

        self.assertEqual(report["provenance"]["corpus"]["origin"], "synthetic")
        self.assertEqual(report["provenance"]["qrels"]["origin"], "agent_authored")
        self.assertEqual(set(report["methods"]), {"fts", "vector", "rrf_fts_vector"})
        self.assertIn(NULL_METHOD_NAME, report)


if __name__ == "__main__":
    unittest.main()
