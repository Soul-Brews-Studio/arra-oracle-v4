"""Owned child process for the writer-gate contention test.

Run as a SUBPROCESS while the parent holds the gate on the same dataset root.
It replaces ``lancedb.connect`` with a sentinel that records the fact it was
reached and then fails. That is the whole point of the file: an exception alone
proves only that the call failed somewhere, while an absent sentinel proves the
refusal happened BEFORE the dataset was opened.

Exit codes (the parent asserts on these, not on stderr text):
  0  refused with writer_unavailable, connect never reached
  3  connect WAS reached -- the gate is not ahead of the dataset open
  4  the call succeeded, or failed some other way

argv: <dataset_root> <sentinel_path>
"""

import json
import sys
import traceback
from pathlib import Path

import lancedb
from arra_migrate.writer_gate import WriterUnavailableError
from export_publication_fixture import create_publication_fixture

REFUSED_BEFORE_CONNECT = 0
CONNECT_REACHED = 3
UNEXPECTED = 4


def main() -> int:
    dataset_root, sentinel_path = sys.argv[1], Path(sys.argv[2])

    def _sentinel_connect(*args, **kwargs):
        # Written BEFORE raising: if the gate ever stops running first, this
        # file survives to say so even though the call still ends in an error.
        sentinel_path.write_text("lancedb.connect was reached\n", encoding="utf-8")
        raise AssertionError("lancedb.connect reached while another owner holds the gate")

    lancedb.connect = _sentinel_connect

    try:
        create_publication_fixture(dataset_root, workspaces=["contender-workspace"])
    except WriterUnavailableError as error:
        print(json.dumps({"outcome": "writer_unavailable", "code": error.code}))
        return CONNECT_REACHED if sentinel_path.exists() else REFUSED_BEFORE_CONNECT
    except BaseException:  # noqa: BLE001 - the parent classifies, this only reports
        traceback.print_exc()
        return CONNECT_REACHED if sentinel_path.exists() else UNEXPECTED
    print(json.dumps({"outcome": "created"}))
    return UNEXPECTED


if __name__ == "__main__":
    sys.exit(main())
