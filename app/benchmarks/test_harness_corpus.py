"""Tests for harness_corpus.py (#7, R16/A2): the provenance-qualified loader.

What these prove: `corpus_origin` (synthetic/agent_authored/user_derived) and
`qrels_origin` (agent_authored/independently_judged) are structural, stamped
by which loader function was called, never by a field in the payload.
`held_out` is a required keyword, never defaulted. Corpus documents carry
title/type/body/lang, not just an id. `bind_qrels` refuses a corpus/qrels
relevant-id mismatch, AND refuses to bind agent-authored qrels for a report
that would claim `independently_judged`.

Run explicitly (outside any discovery root this repo uses):

    cd app/benchmarks
    python -W error::ResourceWarning test_harness_corpus.py -v
"""

import unittest

from harness_corpus import (
    CORPUS_ORIGINS,
    QRELS_ORIGINS,
    CorpusInputError,
    bind_qrels,
    load_agent_authored_corpus,
    load_agent_authored_qrels,
    load_independently_judged_qrels,
    load_synthetic_corpus,
    load_user_derived_corpus,
)


def corpus_payload(**overrides):
    payload = {
        "provenance": {"label": "toy", "source": "hand-authored", "created": "2026-09-21"},
        "documents": [
            {"id": "c1", "title": "t1", "type": "note", "body": "body one", "lang": "en"},
            {"id": "c2", "title": "t2", "type": "note", "body": "body two", "lang": "en"},
            {"id": "c3", "title": "t3", "type": "note", "body": "body three", "lang": "th"},
        ],
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


class OriginConstantsTests(unittest.TestCase):
    def test_corpus_origins_are_exactly_three(self):
        self.assertEqual(set(CORPUS_ORIGINS), {"synthetic", "agent_authored", "user_derived"})

    def test_qrels_origins_are_exactly_two(self):
        self.assertEqual(set(QRELS_ORIGINS), {"agent_authored", "independently_judged"})


class ProvenanceStampingTests(unittest.TestCase):
    def test_synthetic_loader_always_stamps_synthetic(self):
        corpus = load_synthetic_corpus(corpus_payload())
        self.assertEqual(corpus.provenance.origin, "synthetic")

    def test_agent_authored_loader_always_stamps_agent_authored(self):
        corpus = load_agent_authored_corpus(corpus_payload())
        self.assertEqual(corpus.provenance.origin, "agent_authored")

    def test_user_derived_loader_always_stamps_user_derived(self):
        corpus = load_user_derived_corpus(corpus_payload())
        self.assertEqual(corpus.provenance.origin, "user_derived")

    def test_payload_origin_field_is_ignored_by_synthetic_loader(self):
        # A payload that tries to claim "user_derived" through its own data
        # cannot override which loader function was actually called.
        payload = corpus_payload(provenance={
            "label": "toy", "source": "hand-authored", "created": "2026-09-21",
            "origin": "user_derived",
        })
        corpus = load_synthetic_corpus(payload)
        self.assertEqual(corpus.provenance.origin, "synthetic")

    def test_no_public_corpus_loader_accepts_origin_as_a_parameter(self):
        import harness_corpus

        for name in ("load_synthetic_corpus", "load_agent_authored_corpus", "load_user_derived_corpus"):
            func = getattr(harness_corpus, name)
            self.assertNotIn("origin", func.__code__.co_varnames[: func.__code__.co_argcount])

    def test_qrels_loader_requires_held_out_keyword(self):
        with self.assertRaises(TypeError):
            load_agent_authored_qrels(qrels_payload())  # missing required held_out=

    def test_qrels_loader_stamps_held_out_from_the_explicit_keyword(self):
        qrels = load_agent_authored_qrels(qrels_payload(), held_out=True)
        self.assertTrue(qrels.provenance.held_out)
        qrels2 = load_agent_authored_qrels(qrels_payload(), held_out=False)
        self.assertFalse(qrels2.provenance.held_out)

    def test_payload_held_out_field_is_ignored(self):
        payload = qrels_payload(provenance={
            "label": "toy", "source": "hand-authored", "created": "2026-09-21", "held_out": True,
        })
        qrels = load_agent_authored_qrels(payload, held_out=False)
        self.assertFalse(qrels.provenance.held_out)


class CorpusDocumentTests(unittest.TestCase):
    def test_documents_carry_title_type_body_lang(self):
        corpus = load_synthetic_corpus(corpus_payload())
        first = corpus.documents[0]
        self.assertEqual((first.id, first.title, first.type, first.body, first.lang), ("c1", "t1", "note", "body one", "en"))

    def test_document_ids_property_matches_documents(self):
        corpus = load_synthetic_corpus(corpus_payload())
        self.assertEqual(corpus.document_ids, ("c1", "c2", "c3"))

    def test_empty_documents_rejected(self):
        with self.assertRaises(CorpusInputError):
            load_synthetic_corpus(corpus_payload(documents=[]))

    def test_duplicate_document_ids_rejected(self):
        with self.assertRaises(CorpusInputError):
            load_synthetic_corpus(corpus_payload(documents=[
                {"id": "c1", "title": "a", "type": "note", "body": "x", "lang": "en"},
                {"id": "c1", "title": "b", "type": "note", "body": "y", "lang": "en"},
            ]))

    def test_document_missing_a_required_field_rejected(self):
        with self.assertRaises(CorpusInputError):
            load_synthetic_corpus(corpus_payload(documents=[
                {"id": "c1", "title": "a", "type": "note", "body": "x"},  # no lang
            ]))

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
            load_agent_authored_qrels(qrels_payload(queries=[
                {"id": "q1", "relevant_ids": ["c1"]},
                {"id": "q1", "relevant_ids": ["c2"]},
            ]), held_out=True)

    def test_empty_relevant_ids_rejected(self):
        with self.assertRaises(CorpusInputError):
            load_agent_authored_qrels(qrels_payload(queries=[{"id": "q1", "relevant_ids": []}]), held_out=True)


class BindQrelsTests(unittest.TestCase):
    def test_matching_origin_and_ids_binds_cleanly(self):
        corpus = load_agent_authored_corpus(corpus_payload())
        qrels = load_agent_authored_qrels(qrels_payload(), held_out=True)
        self.assertIs(bind_qrels(corpus, qrels, for_report_qrels_origin="agent_authored"), qrels)

    def test_agent_authored_qrels_refused_for_a_report_labelled_independently_judged(self):
        corpus = load_agent_authored_corpus(corpus_payload())
        qrels = load_agent_authored_qrels(qrels_payload(), held_out=True)
        with self.assertRaises(CorpusInputError):
            bind_qrels(corpus, qrels, for_report_qrels_origin="independently_judged")

    def test_independently_judged_qrels_refused_for_a_report_labelled_agent_authored(self):
        corpus = load_user_derived_corpus(corpus_payload())
        qrels = load_independently_judged_qrels(qrels_payload(), held_out=True)
        with self.assertRaises(CorpusInputError):
            bind_qrels(corpus, qrels, for_report_qrels_origin="agent_authored")

    def test_for_report_qrels_origin_is_required(self):
        corpus = load_agent_authored_corpus(corpus_payload())
        qrels = load_agent_authored_qrels(qrels_payload(), held_out=True)
        with self.assertRaises(TypeError):
            bind_qrels(corpus, qrels)

    def test_relevant_id_absent_from_corpus_is_refused(self):
        corpus = load_agent_authored_corpus(corpus_payload(documents=[
            {"id": "c1", "title": "a", "type": "note", "body": "x", "lang": "en"},
            {"id": "c2", "title": "b", "type": "note", "body": "y", "lang": "en"},
        ]))
        qrels = load_agent_authored_qrels(qrels_payload(queries=[{"id": "q1", "relevant_ids": ["c9"]}]), held_out=True)
        with self.assertRaises(CorpusInputError):
            bind_qrels(corpus, qrels, for_report_qrels_origin="agent_authored")


if __name__ == "__main__":
    unittest.main()
