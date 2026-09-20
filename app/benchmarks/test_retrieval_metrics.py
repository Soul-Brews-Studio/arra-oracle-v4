"""Gates for the offline retrieval-metrics evaluator (#52, parent #7).

What these tests prove: the evaluator computes MRR and recall@20 the way the
frozen dispatch defines them, fuses rankings with exact rational arithmetic and
a UTF-16 tie order, excludes literal probes from every aggregate, and refuses a
malformed or incomplete document rather than reporting a partial number.

What they deliberately do NOT prove: that any retrieval profile is good. This
measures a document someone else produced. It runs no model, no index and no
query, and `provenance.held_out` is a caller's claim that nothing here checks.

Golden values come from `fixtures/retrieval-metrics-v1/known-answers.json`,
hand-calculated and stored as exact `[numerator, denominator]` rationals. The
conversion to float happens HERE, so the expectation does not borrow the
implementation's arithmetic. Inline cases below are hand-calculated the same
way, and every one of them keeps the summed numerator dyadic so the mean is a
correctly rounded division rather than an accumulation artefact.

Run it explicitly (it lives outside any discovery root the repo uses):

    cd app/benchmarks
    python -W error::ResourceWarning test_retrieval_metrics.py -v
"""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

import retrieval_metrics
from retrieval_metrics import BenchmarkInputError, evaluate

HERE = Path(__file__).resolve().parent
MODULE = HERE / "retrieval_metrics.py"
GOLDEN = json.loads(
    (HERE / "fixtures" / "retrieval-metrics-v1" / "known-answers.json").read_text(encoding="utf-8")
)

CHILD_DEADLINE_SECONDS = 60.0


def rational(pair):
    """`[n, d]` -> float, or None. The test's own arithmetic, not the module's."""
    if pair is None:
        return None
    return float(Fraction(pair[0], pair[1]))


def encode(document):
    return json.dumps(document, ensure_ascii=False).encode("utf-8")


def base_document(**overrides):
    """A minimal valid document: one corpus item, one query, three runs."""
    document = {
        "version": "arra-retrieval-eval/v1",
        "provenance": {"label": "inline", "held_out": False},
        "corpus": [{"id": "c1"}],
        "queries": [{"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1"]}],
        "runs": {
            name: [{"query_id": "q1", "status": "complete", "ranking": ["c1"]}]
            for name in ("icu", "trigram", "vector")
        },
    }
    document.update(overrides)
    return document


def document_for(corpus, queries, rankings):
    """Build a document whose three profiles share one ranking per query."""
    return {
        "version": "arra-retrieval-eval/v1",
        "provenance": {"label": "inline", "held_out": False},
        "corpus": [{"id": cid} for cid in corpus],
        "queries": queries,
        "runs": {
            name: [
                {"query_id": q["id"], "status": "complete", "ranking": list(rankings[q["id"]])}
                for q in queries
            ]
            for name in ("icu", "trigram", "vector")
        },
    }


class RankMetricTests(unittest.TestCase):
    """Reciprocal rank and recall@20, at the ranks that decide the definitions."""

    def evaluate_single(self, ranking, relevant=("c1",), corpus=None):
        corpus = corpus or [f"c{i}" for i in range(1, 31)]
        queries = [{"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": list(relevant)}]
        result = evaluate(encode(document_for(corpus, queries, {"q1": ranking})))
        return result["profiles"]["icu"]["per_query"]["q1"]

    def test_first_relevant_at_rank_one_two_and_twentyone(self):
        corpus = [f"c{i}" for i in range(1, 31)]
        self.assertEqual(self.evaluate_single(["c1"])["rr"], 1.0)
        self.assertEqual(self.evaluate_single(["c2", "c1"])["rr"], 0.5)

        # Rank 21 is the case the cutoff must NOT touch: RR is over the FULL
        # ranking, so it stays 1/21, while recall@20 is 0 because the hit is
        # outside the window. A truncated RR would report 0 here.
        beyond = [c for c in corpus if c != "c1"][:20] + ["c1"]
        self.assertEqual(len(beyond), 21)
        at21 = self.evaluate_single(beyond)
        self.assertEqual(at21["rr"], float(Fraction(1, 21)))
        self.assertEqual(at21["recall_at_20"], 0.0)

    def test_no_relevant_document_anywhere_scores_zero(self):
        missed = self.evaluate_single(["c2", "c3"])
        self.assertEqual(missed["rr"], 0.0)
        self.assertEqual(missed["recall_at_20"], 0.0)

    def test_recall_counts_every_relevant_id_inside_the_window(self):
        both = self.evaluate_single(["c9", "c1", "c2"], relevant=("c1", "c2"))
        self.assertEqual(both["rr"], 0.5)
        self.assertEqual(both["recall_at_20"], 1.0)

        one = self.evaluate_single(["c9", "c1"], relevant=("c1", "c2"))
        self.assertEqual(one["rr"], 0.5)
        self.assertEqual(one["recall_at_20"], 0.5)

    def test_empty_complete_ranking_is_a_legitimate_zero(self):
        empty = self.evaluate_single([])
        self.assertEqual(empty["rr"], 0.0)
        self.assertEqual(empty["recall_at_20"], 0.0)
        # And it still counts as a measured query, not a missing one.
        result = evaluate(
            encode(
                document_for(
                    ["c1"],
                    [{"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1"]}],
                    {"q1": []},
                )
            )
        )
        self.assertEqual(result["profiles"]["icu"]["summary"]["all"]["queries"], 1)
        self.assertEqual(result["profiles"]["icu"]["summary"]["all"]["mrr"], 0.0)


class AggregateTests(unittest.TestCase):
    """Macro by query, semantic only, split by language."""

    def test_macro_mean_is_not_weighted_by_relevant_count(self):
        # q1 has four relevant documents and finds two; q2 has one and finds it.
        # Macro: (1/2 + 1)/2 = 3/4.  Micro would be (2+1)/(4+1) = 3/5.
        corpus = [f"c{i}" for i in range(1, 8)]
        queries = [
            {"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1", "c2", "c3", "c4"]},
            {"id": "q2", "lang": "en", "purpose": "semantic", "relevant_ids": ["c5"]},
        ]
        result = evaluate(encode(document_for(corpus, queries, {"q1": ["c1", "c2"], "q2": ["c5"]})))
        summary = result["profiles"]["icu"]["summary"]["all"]
        self.assertEqual(summary["macro_recall_at_20"], 0.75)
        self.assertNotEqual(summary["macro_recall_at_20"], float(Fraction(3, 5)))

    def test_language_split_and_an_empty_language_group(self):
        corpus = ["c1", "c2"]
        queries = [
            {"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1"]},
            {"id": "q2", "lang": "en", "purpose": "semantic", "relevant_ids": ["c2"]},
        ]
        result = evaluate(encode(document_for(corpus, queries, {"q1": ["c1"], "q2": []})))
        summary = result["profiles"]["icu"]["summary"]
        self.assertEqual(summary["all"]["queries"], 2)
        self.assertEqual(summary["en"]["queries"], 2)
        # No Thai queries: zero queries and NULL metrics, never a zero that
        # would read as "measured and scored nothing".
        self.assertEqual(summary["th"], {"queries": 0, "mrr": None, "macro_recall_at_20": None})

    def test_literal_probe_is_excluded_even_when_its_result_would_change_the_mean(self):
        corpus = ["c1", "c2"]
        queries = [
            {"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1"]},
            {"id": "q2", "lang": "en", "purpose": "literal", "relevant_ids": ["c2"]},
        ]
        hit = evaluate(encode(document_for(corpus, queries, {"q1": ["c1"], "q2": ["c2"]})))
        miss = evaluate(encode(document_for(corpus, queries, {"q1": ["c1"], "q2": []})))

        for result in (hit, miss):
            summary = result["profiles"]["icu"]["summary"]["all"]
            self.assertEqual(summary["queries"], 1)
            self.assertEqual(summary["mrr"], 1.0)
        # The probe changed, the aggregate did not — but the probe is still
        # reported per query, because excluding it from the mean is not the
        # same as hiding it.
        self.assertEqual(hit["profiles"]["icu"]["per_query"]["q2"]["rr"], 1.0)
        self.assertEqual(miss["profiles"]["icu"]["per_query"]["q2"]["rr"], 0.0)
        self.assertEqual(hit["profiles"]["icu"]["summary"]["all"], miss["profiles"]["icu"]["summary"]["all"])

    def test_a_group_of_only_literal_probes_is_null_not_zero(self):
        corpus = ["c1"]
        queries = [{"id": "q1", "lang": "th", "purpose": "literal", "relevant_ids": ["c1"]}]
        result = evaluate(encode(document_for(corpus, queries, {"q1": ["c1"]})))
        summary = result["profiles"]["icu"]["summary"]
        self.assertEqual(summary["all"], {"queries": 0, "mrr": None, "macro_recall_at_20": None})
        self.assertEqual(summary["th"], {"queries": 0, "mrr": None, "macro_recall_at_20": None})

    def test_per_query_and_rankings_follow_INPUT_query_order(self):
        corpus = ["c1", "c2", "c3"]
        queries = [
            {"id": "qb", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1"]},
            {"id": "qa", "lang": "en", "purpose": "semantic", "relevant_ids": ["c2"]},
            {"id": "qc", "lang": "th", "purpose": "semantic", "relevant_ids": ["c3"]},
        ]
        document = document_for(corpus, queries, {"qb": ["c1"], "qa": ["c2"], "qc": ["c3"]})
        # Runs are listed in a DIFFERENT order; that must not reorder the output.
        for name in document["runs"]:
            document["runs"][name] = list(reversed(document["runs"][name]))
        result = evaluate(encode(document))
        self.assertEqual(list(result["profiles"]["icu"]["per_query"]), ["qb", "qa", "qc"])
        self.assertEqual(list(result["profiles"]["icu"]["rankings"]), ["qb", "qa", "qc"])


class FusionTests(unittest.TestCase):
    """Exact RRF, and the tie order that a codepoint sort gets wrong."""

    def test_hand_authored_tie_breaks_on_utf16_code_units_not_codepoints(self):
        # U+FFFF is a BMP character; U+10000 is supplementary and encodes as the
        # surrogate pair D800 DC00. So in UTF-16 order the supplementary id sorts
        # FIRST, and in Python's native codepoint order it sorts LAST. A tie is
        # the only place that difference is observable, so the test manufactures
        # one: each id appears at rank 1 of exactly one of the two fused
        # rankings, giving both a score of exactly 1/61.
        bmp = "z￿"
        supplementary = "z\U00010000"
        self.assertGreater(supplementary, bmp)  # Python codepoint order
        self.assertLess(
            supplementary.encode("utf-16-be"), bmp.encode("utf-16-be")
        )  # UTF-16 code-unit order

        corpus = [bmp, supplementary]
        queries = [{"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": [bmp]}]
        document = {
            "version": "arra-retrieval-eval/v1",
            "provenance": {"label": "tie", "held_out": False},
            "corpus": [{"id": cid} for cid in corpus],
            "queries": queries,
            "runs": {
                "icu": [{"query_id": "q1", "status": "complete", "ranking": [bmp]}],
                "trigram": [{"query_id": "q1", "status": "complete", "ranking": [bmp]}],
                "vector": [{"query_id": "q1", "status": "complete", "ranking": [supplementary]}],
            },
        }
        fused = evaluate(encode(document))["profiles"]["rrf_icu_vector"]["rankings"]["q1"]
        self.assertEqual(fused, [supplementary, bmp])
        # The relevant id is therefore SECOND, which is what makes the order
        # load-bearing rather than cosmetic.
        self.assertEqual(
            evaluate(encode(document))["profiles"]["rrf_icu_vector"]["per_query"]["q1"]["rr"], 0.5
        )

    def test_scores_sum_across_both_rankings_and_absent_ranks_are_not_invented(self):
        # c1 is rank 2 in both: 1/62 + 1/62 = 1/31.
        # c2 is rank 1 in icu only: 1/61.  1/31 > 1/61, so c1 leads.
        # c3 is rank 1 in vector only: 1/61, tied with c2, broken by id order.
        corpus = ["c1", "c2", "c3"]
        queries = [{"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1"]}]
        document = {
            "version": "arra-retrieval-eval/v1",
            "provenance": {"label": "fusion", "held_out": False},
            "corpus": [{"id": cid} for cid in corpus],
            "queries": queries,
            "runs": {
                "icu": [{"query_id": "q1", "status": "complete", "ranking": ["c2", "c1"]}],
                "trigram": [{"query_id": "q1", "status": "complete", "ranking": []}],
                "vector": [{"query_id": "q1", "status": "complete", "ranking": ["c3", "c1"]}],
            },
        }
        result = evaluate(encode(document))
        self.assertEqual(result["profiles"]["rrf_icu_vector"]["rankings"]["q1"], ["c1", "c2", "c3"])
        # trigram is empty, so the other fusion sees only the vector ranking.
        self.assertEqual(result["profiles"]["rrf_trigram_vector"]["rankings"]["q1"], ["c3", "c1"])

    def test_empty_plus_empty_fuses_to_empty(self):
        corpus = ["c1"]
        queries = [{"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1"]}]
        result = evaluate(encode(document_for(corpus, queries, {"q1": []})))
        for name in ("rrf_icu_vector", "rrf_trigram_vector"):
            self.assertEqual(result["profiles"][name]["rankings"]["q1"], [])
            self.assertEqual(result["profiles"][name]["per_query"]["q1"]["rr"], 0.0)

    def test_the_five_profile_names_are_exactly_these(self):
        result = evaluate(encode(base_document()))
        self.assertEqual(
            list(result["profiles"]),
            ["icu", "trigram", "vector", "rrf_icu_vector", "rrf_trigram_vector"],
        )


class RunValidationTests(unittest.TestCase):
    """A run that is not complete is refused, never silently scored as zero."""

    def reject(self, document):
        with self.assertRaises(BenchmarkInputError):
            evaluate(encode(document))

    def test_incomplete_status_fails_the_whole_evaluation(self):
        document = base_document()
        document["runs"]["icu"][0]["status"] = "timeout"
        self.reject(document)

    def test_missing_extra_and_duplicate_query_entries_are_refused(self):
        missing = base_document()
        missing["runs"]["trigram"] = []
        self.reject(missing)

        extra = base_document()
        extra["runs"]["trigram"].append(
            {"query_id": "q2", "status": "complete", "ranking": []}
        )
        self.reject(extra)

        duplicate = base_document()
        duplicate["runs"]["vector"].append(
            {"query_id": "q1", "status": "complete", "ranking": []}
        )
        self.reject(duplicate)

    def test_missing_profile_is_refused_rather_than_scored_as_zero(self):
        document = base_document()
        del document["runs"]["vector"]
        self.reject(document)

    def test_unknown_or_duplicate_ranking_ids_are_refused(self):
        unknown = base_document()
        unknown["runs"]["icu"][0]["ranking"] = ["not-in-corpus"]
        self.reject(unknown)

        duplicated = base_document(corpus=[{"id": "c1"}, {"id": "c2"}])
        duplicated["runs"]["icu"][0]["ranking"] = ["c1", "c1"]
        self.reject(duplicated)

    def test_query_and_corpus_identity_problems_are_refused(self):
        self.reject(base_document(corpus=[{"id": "c1"}, {"id": "c1"}]))
        self.reject(base_document(corpus=[]))
        self.reject(base_document(queries=[]))

        duplicate_query = base_document(
            queries=[
                {"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1"]},
                {"id": "q1", "lang": "th", "purpose": "semantic", "relevant_ids": ["c1"]},
            ]
        )
        self.reject(duplicate_query)

        dangling = base_document(
            queries=[{"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c9"]}]
        )
        self.reject(dangling)

        repeated_relevant = base_document(
            queries=[{"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": ["c1", "c1"]}]
        )
        self.reject(repeated_relevant)

        empty_relevant = base_document(
            queries=[{"id": "q1", "lang": "en", "purpose": "semantic", "relevant_ids": []}]
        )
        self.reject(empty_relevant)

    def test_closed_objects_and_enumerations(self):
        self.reject(base_document(version="arra-retrieval-eval/v2"))
        self.reject(base_document(unexpected_key=1))

        bad_lang = base_document(
            queries=[{"id": "q1", "lang": "fr", "purpose": "semantic", "relevant_ids": ["c1"]}]
        )
        self.reject(bad_lang)

        bad_purpose = base_document(
            queries=[{"id": "q1", "lang": "en", "purpose": "fuzzy", "relevant_ids": ["c1"]}]
        )
        self.reject(bad_purpose)

        extra_field = base_document()
        extra_field["runs"]["icu"][0]["note"] = "x"
        self.reject(extra_field)

        extra_corpus_field = base_document(corpus=[{"id": "c1", "text": "x"}])
        self.reject(extra_corpus_field)

    def test_provenance_must_be_a_label_and_a_boolean(self):
        self.reject(base_document(provenance={"label": "", "held_out": True}))
        self.reject(base_document(provenance={"label": "x", "held_out": "true"}))
        self.reject(base_document(provenance={"label": "x"}))


class DocumentGrammarTests(unittest.TestCase):
    """Bytes-level strictness, before any metric exists to be partial about."""

    def reject_bytes(self, raw):
        with self.assertRaises(BenchmarkInputError):
            evaluate(raw)

    def test_input_must_be_bytes(self):
        with self.assertRaises(BenchmarkInputError):
            evaluate(json.dumps(base_document()))

    def test_invalid_utf8_is_refused(self):
        self.reject_bytes(b'{"version":"arra-retrieval-eval/v1"\xff}')

    def test_unpaired_surrogate_escape_is_refused(self):
        document = json.dumps(base_document(), ensure_ascii=False)
        self.reject_bytes(document.replace('"inline"', '"in\\ud800line"').encode("utf-8"))

    def test_nonfinite_json_numbers_are_refused(self):
        document = json.dumps(base_document(), ensure_ascii=False)
        self.reject_bytes(document.replace('"held_out": false', '"held_out": NaN').encode("utf-8"))
        self.reject_bytes(
            document.replace('"held_out": false', '"held_out": Infinity').encode("utf-8")
        )

    def test_duplicate_keys_are_refused_at_top_level_and_nested(self):
        document = json.dumps(base_document(), ensure_ascii=False)
        self.reject_bytes(document.replace('{"id": "c1"}', '{"id": "c1", "id": "c2"}').encode("utf-8"))
        self.reject_bytes(
            document.replace(
                '"version": "arra-retrieval-eval/v1"',
                '"version": "arra-retrieval-eval/v1", "version": "arra-retrieval-eval/v1"',
            ).encode("utf-8")
        )
        self.reject_bytes(
            document.replace('"label": "inline"', '"label": "inline", "label": "inline"').encode(
                "utf-8"
            )
        )

    def test_exactly_sixteen_mebibytes_is_accepted_and_one_byte_more_is_not(self):
        limit = 16 * 1024 * 1024
        body = json.dumps(base_document(), ensure_ascii=False).encode("utf-8")
        # Trailing whitespace keeps the document schema-valid, so the ONLY thing
        # under test at the boundary is the byte count.
        exact = body + b" " * (limit - len(body))
        self.assertEqual(len(exact), limit)
        self.assertEqual(evaluate(exact)["cutoff"], 20)
        self.reject_bytes(exact + b" ")

    def test_top_level_must_be_an_object(self):
        self.reject_bytes(b"[]")
        self.reject_bytes(b'"arra-retrieval-eval/v1"')

    def test_deep_nesting_is_refused_as_input_not_raised_as_recursion(self):
        # CPython's JSON parser recurses per nesting level, so ~20 KB of nested
        # brackets exhausts the stack while sitting far below the 16 MiB cap.
        # It must arrive as a refusal like any other malformed document.
        #
        # 1500 and 5000 levels are included on purpose: both are rejected by
        # the SCHEMA, so neither one would notice a raw RecursionError. Only
        # the 10000 case reaches the parser failure, which is what makes it the
        # discriminating probe rather than three copies of the same assertion.
        for levels in (1500, 5000, 10000):
            raw = b'{"x":' + b"[" * levels + b"0" + b"]" * levels + b"}"
            with self.subTest(levels=levels):
                self.assertLess(len(raw), 16 * 1024 * 1024)
                try:
                    self.reject_bytes(raw)
                except RecursionError:  # pragma: no cover - the defect itself
                    self.fail(f"RecursionError escaped for {levels} levels")


class OutputShapeTests(unittest.TestCase):
    """The result document, including what it refuses to claim."""

    def test_top_level_keys_and_pinned_constants(self):
        raw = encode(base_document())
        result = evaluate(raw)
        self.assertEqual(
            list(result),
            [
                "version",
                "input_sha256",
                "provenance",
                "provenance_verification",
                "cutoff",
                "rrf_k",
                "profiles",
            ],
        )
        self.assertEqual(result["version"], "arra-retrieval-metrics/v1")
        self.assertEqual(result["cutoff"], 20)
        self.assertEqual(result["rrf_k"], 60)
        self.assertEqual(result["input_sha256"], hashlib.sha256(raw).hexdigest())

    def test_held_out_is_echoed_but_always_reported_unverified(self):
        for declared in (True, False):
            document = base_document(provenance={"label": "whoever", "held_out": declared})
            result = evaluate(encode(document))
            with self.subTest(held_out=declared):
                self.assertEqual(result["provenance"], {"label": "whoever", "held_out": declared})
                # Accepting the claim is not checking it, and the output has to
                # say so in its own body rather than in a README somewhere.
                self.assertEqual(result["provenance_verification"], "not_verified")

    def test_identical_bytes_give_identical_output(self):
        raw = encode(base_document())
        first = json.dumps(evaluate(raw), ensure_ascii=False, sort_keys=False)
        second = json.dumps(evaluate(raw), ensure_ascii=False, sort_keys=False)
        self.assertEqual(first, second)

    def test_per_query_values_carry_exactly_two_metrics(self):
        result = evaluate(encode(base_document()))
        self.assertEqual(list(result["profiles"]["icu"]["per_query"]["q1"]), ["rr", "recall_at_20"])
        self.assertEqual(
            list(result["profiles"]["icu"]["summary"]["all"]),
            ["queries", "mrr", "macro_recall_at_20"],
        )
        self.assertEqual(list(result["profiles"]["icu"]["summary"]), ["all", "en", "th"])


class GoldenCaseTests(unittest.TestCase):
    """The hand-calculated case, compared value by value."""

    def test_core_case_matches_the_hand_calculated_answers(self):
        raw = encode(GOLDEN["input"])
        result = evaluate(raw)
        self.assertEqual(result["cutoff"], GOLDEN["cutoff"])
        self.assertEqual(result["rrf_k"], GOLDEN["rrf_k"])
        self.assertEqual(sorted(result["profiles"]), sorted(GOLDEN["expected_profiles"]))

        for name, expected in GOLDEN["expected_profiles"].items():
            actual = result["profiles"][name]
            with self.subTest(profile=name):
                self.assertEqual(actual["rankings"], expected["rankings"])
                for qid, metrics in expected["per_query"].items():
                    self.assertEqual(actual["per_query"][qid]["rr"], rational(metrics["rr"]))
                    self.assertEqual(
                        actual["per_query"][qid]["recall_at_20"], rational(metrics["recall_at_20"])
                    )
                for group, summary in expected["summary"].items():
                    self.assertEqual(actual["summary"][group]["queries"], summary["queries"])
                    self.assertEqual(actual["summary"][group]["mrr"], rational(summary["mrr"]))
                    self.assertEqual(
                        actual["summary"][group]["macro_recall_at_20"],
                        rational(summary["macro_recall_at_20"]),
                    )


class CommandLineTests(unittest.TestCase):
    """The CLI, and the promise that importing the module does nothing."""

    def run_cli(self, args, **kwargs):
        return subprocess.run(
            [sys.executable, str(MODULE), *args],
            capture_output=True,
            text=True,
            timeout=CHILD_DEADLINE_SECONDS,
            check=False,
            **kwargs,
        )

    def test_success_writes_one_json_document_to_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.json"
            raw = encode(GOLDEN["input"])
            path.write_bytes(raw)
            done = self.run_cli([str(path)])
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stderr, "")
            parsed = json.loads(done.stdout)
            self.assertEqual(parsed["input_sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(parsed, evaluate(raw))
            # Exactly one document: nothing else printed around it.
            self.assertEqual(done.stdout.count("\n"), 1)
            # The input file is not rewritten.
            self.assertEqual(path.read_bytes(), raw)

    def test_failure_is_a_fixed_message_and_a_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.json"
            path.write_bytes(b'{"version":"arra-retrieval-eval/v1","secret":"do-not-echo-me"}')
            done = self.run_cli([str(path)])
            self.assertNotEqual(done.returncode, 0)
            self.assertEqual(done.stderr.strip(), "invalid benchmark input")
            self.assertEqual(done.stdout, "")
            # No partial metrics, and no fragment of the rejected document.
            self.assertNotIn("do-not-echo-me", done.stderr)

    def test_missing_file_and_wrong_argument_count_use_the_same_message(self):
        for args in ([], ["a", "b"], [str(Path(tempfile.gettempdir()) / "definitely-absent.json")]):
            with self.subTest(args=args):
                done = self.run_cli(args)
                self.assertNotEqual(done.returncode, 0)
                self.assertEqual(done.stderr.strip(), "invalid benchmark input")
                self.assertEqual(done.stdout, "")

    def test_deeply_nested_input_exits_cleanly_instead_of_printing_a_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "deep.json"
            levels = 10000
            path.write_bytes(b'{"x":' + b"[" * levels + b"0" + b"]" * levels + b"}")
            # The parent owns the deadline; run_cli times out rather than hangs.
            done = self.run_cli([str(path)])
            self.assertNotEqual(done.returncode, 0)
            self.assertEqual(done.stdout, "")
            self.assertEqual(done.stderr.strip(), "invalid benchmark input")
            # The exact symptom that was reported: a traceback reaching stderr.
            self.assertNotIn("Traceback", done.stderr)
            self.assertNotIn("RecursionError", done.stderr)

    def test_a_file_larger_than_the_cap_is_rejected_without_reading_it_all(self):
        limit = 16 * 1024 * 1024
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "oversize.json"
            body = encode(base_document())
            # One byte past the cap is enough to be refused; the CLI reads at
            # most cap + 1 rather than pulling the whole file in to reject it.
            path.write_bytes(body + b" " * (limit + 1 - len(body)))
            self.assertEqual(path.stat().st_size, limit + 1)
            done = self.run_cli([str(path)])
            self.assertNotEqual(done.returncode, 0)
            self.assertEqual(done.stdout, "")
            self.assertEqual(done.stderr.strip(), "invalid benchmark input")

    def test_importing_the_module_performs_no_io_and_prints_nothing(self):
        # `open` is replaced before the import, so any module-level file access
        # raises instead of quietly succeeding.
        probe = "\n".join(
            [
                "import builtins, sys",
                "def boom(*a, **k):",
                "    raise AssertionError('import performed file I/O')",
                "builtins.open = boom",
                f"sys.path.insert(0, {str(HERE)!r})",
                "import retrieval_metrics",
                "sys.stderr.write('imported')",
            ]
        )
        done = subprocess.run(
            [sys.executable, "-c", probe],
            capture_output=True,
            text=True,
            timeout=CHILD_DEADLINE_SECONDS,
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, "")
        self.assertEqual(done.stderr, "imported")

    def test_the_module_exposes_only_the_contracted_surface(self):
        self.assertEqual(
            sorted(retrieval_metrics.__all__), ["BenchmarkInputError", "evaluate", "main"]
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
