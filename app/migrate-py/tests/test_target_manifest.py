import json
import unittest
from pathlib import Path

from arra_migrate.models import TABLES
from arra_migrate.target_manifest import validate_target_manifest

MANIFEST = Path(__file__).parents[1] / "contracts" / "target-19-manifest.json"


class TargetManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(MANIFEST.read_text())

    def test_manifest_is_explicit_and_active_since_r32(self):
        # R32 (Nat 2026-09-28, #135): target-19 is what `python -m arra_migrate`
        # creates by default. `current_registry_tables` keeps its frozen v1 key
        # name but now records the LEGACY active-15 set the target replaced,
        # still created by `--legacy-active15` for the legacy routes.
        manifest = self.manifest
        target = manifest["target_tables"]
        current = manifest["current_registry_tables"]
        self.assertEqual(manifest["status"], "active")
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
        manifest = self.manifest
        self.assertEqual(manifest["target_tables"][:5], [
            "workspaces", "peers", "sessions", "session_peers", "messages",
        ])
        self.assertIn("deferred", manifest)
        self.assertTrue(manifest["deferred"])

    def test_validator_accepts_active_and_rejects_junk_and_the_stale_status(self):
        self.assertEqual(validate_target_manifest(self.manifest)["status"], "active")
        cases = []
        # "proposed-not-active" is rejected too: the manifest must not be able
        # to drift back to a status that no longer describes the default.
        for status in ("proposed-not-active", "ACTIVE", "active ", "", None, 1, "enabled"):
            changed = dict(self.manifest)
            changed["status"] = status
            cases.append(changed)
        for field, value in (("target_count", 18), ("target_tables", self.manifest["target_tables"][:-1]), ("current_registry_tables", self.manifest["current_registry_tables"] + ["extra"])):
            changed = dict(self.manifest)
            changed[field] = value
            cases.append(changed)
        for changed in cases:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                validate_target_manifest(changed)
