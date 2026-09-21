"""Tests for harness_runner.py (#7): the multi-method comparable report.

What these prove: every run reports a null baseline for every metric at every
cutoff, every method (including an RRF fusion candidate) is scored the exact
same way so methods are comparable, `delta_from_null` is computed correctly,
provenance passes through untouched, and a configuration mistake (missing
ranking, reserved name, unknown fuse reference) is refused before any metric
is computed.

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

from harness_corpus import bind_qrels, load_synthetic_corpus, load_synthetic_qrels
from harness_runner import NULL_METHOD_NAME, RunnerInputError, null_ranking, run_benchmark

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "harness-v1" / "synthetic-example.json"


def toy_corpus():
    return load_synthetic_corpus({
        "provenance": {"label": "toy", "source": "hand-authored", "created": "2026-09-21"},
        "document_ids": ["c1", "c2", "c3", "c4", "c5"],
    })


def toy_qrels():
    qrels = load_synthetic_qrels({
        "provenance": {"label": "toy", "source": "hand-authored", "created": "2026-09-21"},
        "queries": [
            {"id": "q1", "relevant_ids": ["c1"], "lang": "en", "purpose": "semantic"},
            {"id": "q2", "relevant_ids": ["c2"], "lang": "en", "purpose": "semantic"},
        ],
    })
    return bind_qrels(toy_corpus(), qrels)


def toy_methods():
    return {
        "fts": {"q1": ["c1", "c2", "c3", "c4", "c5"], "q2": ["c1", "c2", "c3", "c4", "c5"]},
        "vector": {"q1": ["c4", "c5", "c1", "c2", "c3"], "q2": ["c4", "c5", "c2", "c1", "c3"]},
    }


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


class RunBenchmarkStructureTests(unittest.TestCase):
    def setUp(self):
        self.corpus = toy_corpus()
        self.qrels = toy_qrels()
        self.report = run_benchmark(
            self.corpus, self.qrels, toy_methods(),
            fuse=[("rrf_fts_vector", "fts", "vector")],
            cutoffs=(1, 5),
        )

    def test_provenance_passes_through_untouched(self):
        self.assertEqual(self.report["provenance"]["kind"], "synthetic")
        self.assertEqual(self.report["provenance"]["label"], "toy")

    def test_every_supplied_method_and_the_fusion_are_present(self):
        self.assertEqual(set(self.report["methods"]), {"fts", "vector", "rrf_fts_vector"})

    def test_null_baseline_is_a_top_level_sibling_not_a_method(self):
        self.assertIn(NULL_METHOD_NAME, self.report)
        self.assertNotIn(NULL_METHOD_NAME, self.report["methods"])

    def test_null_baseline_reports_every_metric_at_every_cutoff(self):
        null_summary = self.report[NULL_METHOD_NAME]["summary"]
        self.assertIn("mrr", null_summary)
        self.assertEqual(set(null_summary["recall_at_k"]), {1, 5})
        self.assertEqual(set(null_summary["precision_at_k"]), {1, 5})

    def test_delta_from_null_present_for_every_method_and_every_metric(self):
        for name in ("fts", "vector", "rrf_fts_vector"):
            delta = self.report["methods"][name]["delta_from_null"]
            self.assertIn("mrr", delta)
            self.assertEqual(set(delta["recall_at_k"]), {1, 5})
            self.assertEqual(set(delta["precision_at_k"]), {1, 5})

    def test_delta_from_null_is_exactly_method_minus_null(self):
        null_mrr = self.report[NULL_METHOD_NAME]["summary"]["mrr"]
        fts_mrr = self.report["methods"]["fts"]["summary"]["mrr"]
        fts_delta = self.report["methods"]["fts"]["delta_from_null"]["mrr"]
        self.assertAlmostEqual(fts_delta, fts_mrr - null_mrr)

    def test_fts_beats_vector_on_this_fixture_and_the_report_shows_it_per_method(self):
        # fts finds q1's relevant doc at rank 1 and q2's at rank 2 (mrr 0.75);
        # vector finds both only at rank 3 (mrr 1/3). The report must expose
        # this as SEPARATE method scores, not just a fused number -- exactly
        # the shape needed to show RRF underperforming a component, per the
        # fleet's measured real-corpus finding.
        fts_mrr = self.report["methods"]["fts"]["summary"]["mrr"]
        vector_mrr = self.report["methods"]["vector"]["summary"]["mrr"]
        rrf_mrr = self.report["methods"]["rrf_fts_vector"]["summary"]["mrr"]
        self.assertEqual(fts_mrr, 0.75)
        self.assertAlmostEqual(vector_mrr, float(Fraction(1, 3)))
        self.assertGreater(fts_mrr, vector_mrr)
        # Fusion sits below the winning component here -- a fused score alone
        # would hide that fts was doing the actual work.
        self.assertLess(rrf_mrr, fts_mrr)


class RunBenchmarkGuardTests(unittest.TestCase):
    def test_missing_ranking_for_a_query_is_refused(self):
        methods = toy_methods()
        del methods["vector"]["q2"]
        with self.assertRaises(RunnerInputError):
            run_benchmark(toy_corpus(), toy_qrels(), methods)

    def test_reserved_null_method_name_is_refused(self):
        methods = toy_methods()
        methods[NULL_METHOD_NAME] = methods["fts"]
        with self.assertRaises(RunnerInputError):
            run_benchmark(toy_corpus(), toy_qrels(), methods)

    def test_fuse_referencing_unknown_method_is_refused(self):
        with self.assertRaises(RunnerInputError):
            run_benchmark(toy_corpus(), toy_qrels(), toy_methods(), fuse=[("rrf", "fts", "missing")])

    def test_no_methods_is_refused(self):
        with self.assertRaises(RunnerInputError):
            run_benchmark(toy_corpus(), toy_qrels(), {})


class SyntheticFixtureEndToEndTest(unittest.TestCase):
    """Loads fixtures/harness-v1/synthetic-example.json through the real
    loader-to-runner path, proving the pieces wire together end to end and
    that the fixture's own JSON stays a synthetic result, not a held-out one."""

    def test_fixture_runs_and_stays_labelled_synthetic(self):
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        corpus = load_synthetic_corpus(data["corpus"])
        qrels = bind_qrels(corpus, load_synthetic_qrels(data["qrels"]))
        report = run_benchmark(corpus, qrels, data["methods"], fuse=[tuple(data["fuse"][0])])

        self.assertEqual(report["provenance"]["kind"], "synthetic")
        self.assertEqual(set(report["methods"]), {"fts", "vector", "rrf_fts_vector"})
        self.assertIn(NULL_METHOD_NAME, report)


if __name__ == "__main__":
    unittest.main()
