"""Golden tests for harness_metrics.py (#7).

Every expected value below is hand-computed in the test itself, not borrowed
from the module under test -- these are the numbers a person with a pencil
would get, checked against what the code returns.

Run explicitly (outside any discovery root this repo uses):

    cd app/benchmarks
    python -W error::ResourceWarning test_harness_metrics.py -v
"""

import unittest
from fractions import Fraction

from harness_metrics import (
    fuse_rrf,
    macro_mean,
    precision_at_k,
    reciprocal_rank,
    recall_at_k,
    score_query,
)


class ReciprocalRankTests(unittest.TestCase):
    def test_hit_at_rank_one(self):
        self.assertEqual(reciprocal_rank(["c1", "c2"], {"c1"}), Fraction(1, 1))

    def test_hit_at_rank_two(self):
        self.assertEqual(reciprocal_rank(["c2", "c1"], {"c1"}), Fraction(1, 2))

    def test_no_hit_is_zero(self):
        self.assertEqual(reciprocal_rank(["c2", "c3"], {"c1"}), Fraction(0))

    def test_first_of_several_relevant_ids_counts(self):
        # c1 is relevant and appears first among relevant ids in the ranking.
        self.assertEqual(reciprocal_rank(["c9", "c1", "c4"], {"c1", "c4"}), Fraction(1, 2))

    def test_not_truncated_by_any_cutoff(self):
        ranking = [f"c{i}" for i in range(1, 22)]  # c1..c21, relevant is last
        self.assertEqual(reciprocal_rank(ranking, {"c21"}), Fraction(1, 21))


class RecallAtKTests(unittest.TestCase):
    def test_all_relevant_found_within_k(self):
        self.assertEqual(recall_at_k(["c1", "c2", "c3"], {"c1", "c2"}, k=3), Fraction(1, 1))

    def test_partial_recall(self):
        # relevant = {c1, c4}; only c1 is in the top 2.
        self.assertEqual(recall_at_k(["c1", "c2", "c4"], {"c1", "c4"}, k=2), Fraction(1, 2))

    def test_relevant_outside_k_is_not_counted(self):
        self.assertEqual(recall_at_k(["c9", "c1"], {"c1"}, k=1), Fraction(0, 1))

    def test_empty_relevant_is_a_caller_error(self):
        with self.assertRaises(ValueError):
            recall_at_k(["c1"], frozenset(), k=5)


class PrecisionAtKTests(unittest.TestCase):
    def test_two_of_three_top_results_relevant(self):
        self.assertEqual(precision_at_k(["c1", "c2", "c9"], {"c1", "c9"}, k=3), Fraction(2, 3))

    def test_short_ranking_counts_missing_slots_against_precision(self):
        # Only one result at all, k=5: 1 relevant hit out of 5 requested slots.
        self.assertEqual(precision_at_k(["c1"], {"c1"}, k=5), Fraction(1, 5))

    def test_empty_ranking_is_zero(self):
        self.assertEqual(precision_at_k([], {"c1"}, k=3), Fraction(0, 3))

    def test_k_must_be_positive(self):
        with self.assertRaises(ValueError):
            precision_at_k(["c1"], {"c1"}, k=0)


class ScoreQueryTests(unittest.TestCase):
    def test_bundles_rr_recall_and_precision_at_every_cutoff(self):
        result = score_query(["c2", "c1", "c3"], {"c1"}, cutoffs=(1, 2, 3))
        self.assertEqual(result["rr"], 0.5)
        self.assertEqual(result["recall_at_k"], {1: 0.0, 2: 1.0, 3: 1.0})
        self.assertEqual(result["precision_at_k"], {1: 0.0, 2: 0.5, 3: float(Fraction(1, 3))})


class MacroMeanTests(unittest.TestCase):
    def test_mean_of_three(self):
        self.assertEqual(macro_mean([1.0, 0.5, 0.0]), 0.5)

    def test_empty_group_is_none_not_zero(self):
        self.assertIsNone(macro_mean([]))

    def test_not_weighted_by_anything_but_query_count(self):
        # Caller already macro-weighted per query before this point; macro_mean
        # itself just averages whatever list it is handed.
        self.assertEqual(macro_mean([1.0, 1.0, 1.0, 0.0]), 0.75)


class FuseRRFTests(unittest.TestCase):
    def test_hand_computed_fusion_order(self):
        # first: a@1, b@2 -> a=1/61, b=1/62
        # second: b@1, c@2 -> b=1/61, c=1/62
        # b total = 1/62 + 1/61 ~ 0.032523 (highest)
        # a total = 1/61 ~ 0.016393
        # c total = 1/62 ~ 0.016129
        result = fuse_rrf(["a", "b"], ["b", "c"], k=60)
        self.assertEqual(result, ["b", "a", "c"])

    def test_id_absent_from_a_ranking_gets_no_invented_rank(self):
        # "z" never appears in either ranking, so it must never appear in fusion.
        result = fuse_rrf(["a"], ["a"], k=60)
        self.assertEqual(result, ["a"])
        self.assertNotIn("z", result)

    def test_tie_breaks_on_utf16_code_units(self):
        # Two ids that never co-occur each score exactly 1/61 -- an exact tie.
        # UTF-16 code unit order: "a" (0x0061) < "b" (0x0062).
        result = fuse_rrf(["b"], ["a"], k=60)
        self.assertEqual(result, ["a", "b"])


if __name__ == "__main__":
    unittest.main()
