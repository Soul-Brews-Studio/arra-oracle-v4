import json
import unittest
from pathlib import Path

from arra_migrate.models import TABLES


MANIFEST = Path(__file__).parents[1] / "contracts" / "target-19-manifest.json"


class TargetManifestTests(unittest.TestCase):
    def test_manifest_is_explicit_and_not_active_registry(self):
        manifest = json.loads(MANIFEST.read_text())
        target = manifest["target_tables"]
        current = manifest["current_registry_tables"]
        self.assertEqual(manifest["status"], "proposed-not-active")
        self.assertEqual(manifest["target_count"], 19)
        self.assertEqual(len(target), 19)
        self.assertEqual(len(set(target)), 19)
        self.assertEqual(set(TABLES), set(current))
        self.assertEqual(len(TABLES), 15)
        self.assertNotEqual(set(target), set(TABLES))
        self.assertEqual(set(target) - set(current), {
            "session_links", "nodes", "node_revisions", "node_revision_terms",
            "revision_links", "search_chunks_v1",
        })

    def test_manifest_contains_only_named_lanes(self):
        manifest = json.loads(MANIFEST.read_text())
        self.assertEqual(manifest["target_tables"][:5], [
            "workspaces", "peers", "sessions", "session_peers", "messages",
        ])
        self.assertIn("deferred", manifest)
        self.assertTrue(manifest["deferred"])
