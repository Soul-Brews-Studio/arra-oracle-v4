"""Enforce Nat's 500-line cap on tracked Python source under app/migrate-py/src.

docs/overnight/DECISIONS.md + docs/overnight/PLAN.md (2026-09-26/27, py-split
slice): "one function per file, no file over 500 lines", behaviour-preserving
moves only. This test is deliberately dumb (line count only) so it cannot be
fooled by reformatting.

Single documented exemption: `revision_v1.py` is pinned by the isolation
contract in `test_revision_v1.py::IsolationTests` (and
`app/docs/contracts/revision-evidence-v1.md`), which asserts that NO OTHER
Python file under this src tree may mention the string "revision_v1". Every
name still usable from a helper module that needs to hand data back to
`revision_v1.py` would have to reference it by that name, which the guard
forbids. If a future split needs that, the guard has to move first; until
then this file keeps its historical size.
"""

from __future__ import annotations

import unittest
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src" / "arra_migrate"
LINE_CAP = 500

# See module docstring: splitting this file further would require a helper
# module that imports back from it, which is exactly what the isolation
# guard in test_revision_v1.py (IsolationTests) forbids.
GUARD_EXEMPT = {"revision_v1.py"}


class FileSizeCapTests(unittest.TestCase):
    def test_no_python_source_file_exceeds_the_line_cap(self):
        scanned = sorted(SRC_ROOT.rglob("*.py"))
        self.assertGreaterEqual(len(scanned), 35, f"scan collapsed: {len(scanned)} files")
        offenders = []
        for path in scanned:
            if path.name in GUARD_EXEMPT:
                continue
            line_count = len(path.read_text(encoding="utf-8").splitlines())
            if line_count > LINE_CAP:
                offenders.append((str(path.relative_to(SRC_ROOT)), line_count))
        self.assertEqual(offenders, [], f"files over the {LINE_CAP}-line cap: {offenders}")


if __name__ == "__main__":
    unittest.main()
