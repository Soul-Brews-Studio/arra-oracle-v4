"""Tests for harness_corpus.py (#7): the provenance-qualified loader.

What these prove: the synthetic/held-out distinction is structural, not a
label a caller can set. `load_synthetic_corpus` always stamps "synthetic" no
matter what the payload's own "kind"/"held_out"-shaped fields say, and
`bind_qrels` refuses to pair a corpus and qrels of different kinds or with a
relevant id the corpus doesn't contain.

Run explicitly (outside any discovery root this repo uses):

    cd app/benchmarks
    python -W error::ResourceWarning test_harness_corpus.py -v
"""

import unittest

from harness_corpus import (
    CorpusInputError,
    bind_qrels,
    load_held_out_corpus,
    load_held_out_qrels,
    load_synthetic_corpus,
    load_synthetic_qrels,
)


def corpus_payload(**overrides):
    payload = {
        "provenance": {"label": "toy", "source": "hand-authored", "created": "2026-09-21"},
        "document_ids": ["c1", "c2", "c3"],
    }
    payload.update(overrides)
    return payload


def qrels_payload(**overrides):
    payload = {
        "provenance": {"label": "toy", "source": "hand-authored", "created": "2026-09-21"},
        "queries": [{"id": "q1", "relevant_ids": ["c1"], "lang": "en", "purpose": "semantic"}],
    }
    payload.update(overrides)
    return payload


class ProvenanceStampingTests(unittest.TestCase):
    def test_synthetic_loader_always_stamps_synthetic(self):
        corpus = load_synthetic_corpus(corpus_payload())
        self.assertEqual(corpus.provenance.kind, "synthetic")

    def test_held_out_loader_always_stamps_held_out(self):
        corpus = load_held_out_corpus(corpus_payload())
        self.assertEqual(corpus.provenance.kind, "held_out")

    def test_payload_kind_field_is_ignored_by_synthetic_loader(self):
        # A payload that tries to claim "held_out" through its own data cannot
        # override which loader function was actually called.
        payload = corpus_payload(provenance={
            "label": "toy", "source": "hand-authored", "created": "2026-09-21",
            "kind": "held_out",
        })
        corpus = load_synthetic_corpus(payload)
        self.assertEqual(corpus.provenance.kind, "synthetic")

    def test_no_public_function_accepts_kind_as_a_parameter(self):
        import harness_corpus

        for name in ("load_synthetic_corpus", "load_held_out_corpus", "load_synthetic_qrels", "load_held_out_qrels"):
            func = getattr(harness_corpus, name)
            self.assertNotIn("kind", func.__code__.co_varnames[: func.__code__.co_argcount])


class CorpusValidationTests(unittest.TestCase):
    def test_empty_document_ids_rejected(self):
        with self.assertRaises(CorpusInputError):
            load_synthetic_corpus(corpus_payload(document_ids=[]))

    def test_duplicate_document_ids_rejected(self):
        with self.assertRaises(CorpusInputError):
            load_synthetic_corpus(corpus_payload(document_ids=["c1", "c1"]))

    def test_missing_provenance_field_rejected(self):
        with self.assertRaises(CorpusInputError):
            load_synthetic_corpus(corpus_payload(provenance={"label": "toy"}))

    def test_accepts_json_bytes_as_well_as_dict(self):
        import json

        raw = json.dumps(corpus_payload()).encode("utf-8")
        corpus = load_synthetic_corpus(raw)
        self.assertEqual(corpus.document_ids, ("c1", "c2", "c3"))


class QrelsValidationTests(unittest.TestCase):
    def test_duplicate_query_id_rejected(self):
        with self.assertRaises(CorpusInputError):
            load_synthetic_qrels(qrels_payload(queries=[
                {"id": "q1", "relevant_ids": ["c1"]},
                {"id": "q1", "relevant_ids": ["c2"]},
            ]))

    def test_empty_relevant_ids_rejected(self):
        with self.assertRaises(CorpusInputError):
            load_synthetic_qrels(qrels_payload(queries=[{"id": "q1", "relevant_ids": []}]))


class BindQrelsTests(unittest.TestCase):
    def test_matching_kind_and_ids_binds_cleanly(self):
        corpus = load_synthetic_corpus(corpus_payload())
        qrels = load_synthetic_qrels(qrels_payload())
        self.assertIs(bind_qrels(corpus, qrels), qrels)

    def test_kind_mismatch_is_refused(self):
        corpus = load_synthetic_corpus(corpus_payload())
        qrels = load_held_out_qrels(qrels_payload())
        with self.assertRaises(CorpusInputError):
            bind_qrels(corpus, qrels)

    def test_relevant_id_absent_from_corpus_is_refused(self):
        corpus = load_synthetic_corpus(corpus_payload(document_ids=["c1", "c2"]))
        qrels = load_synthetic_qrels(qrels_payload(queries=[{"id": "q1", "relevant_ids": ["c9"]}]))
        with self.assertRaises(CorpusInputError):
            bind_qrels(corpus, qrels)


if __name__ == "__main__":
    unittest.main()
