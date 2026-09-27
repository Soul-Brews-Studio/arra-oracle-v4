"""Owned child for the taxonomy fixture's writer-gate ordering test.

Run as a SUBPROCESS while the parent holds the gate on the same dataset root.
``lancedb.connect`` is replaced with a sentinel that RECORDS being reached and
then fails, because the distinction under test is not "did the call fail" but
"how far did it get before failing". A raised ``writer_unavailable`` on its own
is compatible with a creator that opened the dataset first and only then
checked the lock; an absent sentinel file is what rules that out.

The same child is also run with the gate FREE, as a positive control. If the
sentinel never fires in that run, the sentinel itself is broken and every
"refused before connect" result above it is worthless.

Exit codes, which is all the parent asserts on:
  0  refused with writer_unavailable and connect was never reached
  3  connect WAS reached -- the gate does not run ahead of the dataset open
  4  anything else, including an unexpected success

argv: <dataset_root> <sentinel_path>
"""

import json
import sys
import traceback
from pathlib import Path

import lancedb

from arra_migrate.writer_gate import WriterUnavailableError

REFUSED_BEFORE_CONNECT = 0
CONNECT_REACHED = 3
UNEXPECTED = 4


def main() -> int:
    dataset_root, sentinel_path = sys.argv[1], Path(sys.argv[2])

    def _sentinel_connect(*args, **kwargs):
        # Written BEFORE raising, so the evidence survives even though the
        # call still ends in an error.
        sentinel_path.write_text("lancedb.connect was reached\n", encoding="utf-8")
        raise AssertionError("lancedb.connect reached while another owner holds the gate")

    lancedb.connect = _sentinel_connect

    # Imported AFTER the patch so the creator resolves the patched attribute.
    from export_taxonomy_fixture import create_taxonomy_fixture

    try:
        create_taxonomy_fixture(dataset_root, workspaces=["contender-workspace"])
    except WriterUnavailableError as error:
        print(json.dumps({"outcome": "writer_unavailable", "code": error.code}))
        return CONNECT_REACHED if sentinel_path.exists() else REFUSED_BEFORE_CONNECT
    except BaseException:  # noqa: BLE001 - the parent classifies; this only reports
        traceback.print_exc()
        return CONNECT_REACHED if sentinel_path.exists() else UNEXPECTED
    print(json.dumps({"outcome": "created"}))
    return UNEXPECTED


if __name__ == "__main__":
    sys.exit(main())
