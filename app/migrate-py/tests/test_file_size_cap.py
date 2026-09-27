"""Enforce Nat's 500-line cap on tracked Python source under app/migrate-py/src.

docs/overnight/PLAN.md §1 (2026-09-26 21:00 entry, "Code style from Nat: one
function per file, 350-500 line cap per file"), applied by the 2026-09-27
py-split slice: behaviour-preserving moves only, no file over 500 lines. This
test is deliberately dumb (line count only) so it cannot be fooled by
reformatting.

No exemptions. `revision_v1.py` was previously carried at 773 lines with a
`GUARD_EXEMPT` hole in this test that hid it from the cap entirely (proven a
no-op by reverting the split under the exemption and watching this test still
pass). The isolation contract in `test_revision_v1.py::IsolationTests` was
extended -- not weakened -- to treat `revision_v1.py` and its sibling
`contract_batch_frame.py` as one adapter unit for the "no active import" and
"no LanceDB/storage import" checks (`app/docs/contracts/revision-evidence-v1.md`
§8: "no import into active migrator/storage path"; "The adapter does not open
LanceDB"). With that extension in place the split needs no exemption here:
`revision_v1.py` is legitimately under the cap.
"""

from __future__ import annotations

import unittest
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src" / "arra_migrate"
LINE_CAP = 500


class FileSizeCapTests(unittest.TestCase):
    def test_no_python_source_file_exceeds_the_line_cap(self):
        scanned = sorted(SRC_ROOT.rglob("*.py"))
        self.assertGreaterEqual(len(scanned), 35, f"scan collapsed: {len(scanned)} files")
        offenders = []
        for path in scanned:
            line_count = len(path.read_text(encoding="utf-8").splitlines())
            if line_count > LINE_CAP:
                offenders.append((str(path.relative_to(SRC_ROOT)), line_count))
        self.assertEqual(offenders, [], f"files over the {LINE_CAP}-line cap: {offenders}")


if __name__ == "__main__":
    unittest.main()
