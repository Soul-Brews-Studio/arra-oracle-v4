"""Tests for harness_manifest.py (#7, R16/A1): the required manifest schema.

What these prove: every required top-level and nested key must be present
(value `None` is fine -- only ABSENCE is refused), and a full manifest
round-trips unchanged.

Run explicitly (outside any discovery root this repo uses):

    cd app/benchmarks
    python -W error::ResourceWarning test_harness_manifest.py -v
"""

import unittest

from harness_manifest import ManifestInputError, validate_manifest


def full_manifest(**overrides):
    manifest = {
        "engine": {"@lancedb/lancedb": "0.38.0", "apache-arrow": "18.1.0"},
        "tokenizers": {
            "icu": {"base_tokenizer": "icu", "language": "English", "stem": True, "remove_stop_words": True},
            "ngram3": {"base_tokenizer": "ngram", "min_ngram_length": 3, "max_ngram_length": 3, "stem": False, "remove_stop_words": False},
        },
        "indexed_text_composition": "${title}\n\n${body}",
        "candidate_limit": 5,
        "eligibility_filter": "workspace_name = 'bench'",
        "embedding": {
            "status": "not_run",
            "model": None,
            "ollama_digest": None,
            "dims": None,
            "distance": None,
            "normalization": None,
            "request_options": None,
        },
        "artifact_sha256": {"corpus": "a" * 64, "queries": "b" * 64, "qrels": "c" * 64, "vectors": None},
        "rrf": {"k": 60, "tie_rule": "utf16_code_unit"},
    }
    manifest.update(overrides)
    return manifest


class ManifestValidationTests(unittest.TestCase):
    def test_full_manifest_passes_and_is_returned_unchanged(self):
        manifest = full_manifest()
        self.assertIs(validate_manifest(manifest), manifest)

    def test_not_a_dict_is_refused(self):
        with self.assertRaises(ManifestInputError):
            validate_manifest(["not", "a", "dict"])

    def test_missing_top_level_key_is_refused(self):
        manifest = full_manifest()
        del manifest["rrf"]
        with self.assertRaises(ManifestInputError):
            validate_manifest(manifest)

    def test_missing_engine_subkey_is_refused(self):
        manifest = full_manifest()
        del manifest["engine"]["apache-arrow"]
        with self.assertRaises(ManifestInputError):
            validate_manifest(manifest)

    def test_missing_embedding_subkey_is_refused(self):
        manifest = full_manifest()
        del manifest["embedding"]["normalization"]
        with self.assertRaises(ManifestInputError):
            validate_manifest(manifest)

    def test_missing_embedding_request_options_subkey_is_refused(self):
        # A1(c) (analysis-7) lists request options (e.g. truncate/keep_alive)
        # among the embedding facts a manifest must carry.
        manifest = full_manifest()
        del manifest["embedding"]["request_options"]
        with self.assertRaises(ManifestInputError):
            validate_manifest(manifest)

    def test_none_value_for_a_present_key_is_accepted(self):
        # embedding.model is None because the vector profile did not run --
        # that is a fact the report must carry, not an error.
        manifest = full_manifest()
        self.assertIsNone(manifest["embedding"]["model"])
        validate_manifest(manifest)  # does not raise

    def test_missing_artifact_sha256_subkey_is_refused(self):
        manifest = full_manifest()
        del manifest["artifact_sha256"]["vectors"]
        with self.assertRaises(ManifestInputError):
            validate_manifest(manifest)

    def test_missing_rrf_subkey_is_refused(self):
        manifest = full_manifest()
        del manifest["rrf"]["tie_rule"]
        with self.assertRaises(ManifestInputError):
            validate_manifest(manifest)

    def test_empty_tokenizers_is_refused(self):
        manifest = full_manifest(tokenizers={})
        with self.assertRaises(ManifestInputError):
            validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
