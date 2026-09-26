"""Launch the Bun knowledge worker with the orchestrator's held writer gate.

The worker (``app/server/src/migration/worker.ts``) is an argument-array
subprocess with a hard deadline and bounded output; it never runs through a
shell. Its stdout is JSONL outcome lines (see ``results.py``); a nonzero exit
or an unparsable line is a ``CopyMigrationFailed``, never a partial success.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve()
SERVER_DIR = _HERE.parents[4] / "server"
WORKER_SCRIPT = SERVER_DIR / "src" / "migration" / "worker.ts"
DEADLINE_SECONDS = 600.0
MAX_STDOUT_BYTES = 64 * 1024 * 1024


class CopyMigrationFailed(RuntimeError):
    """The knowledge phase did not complete. The candidate must be discarded."""


def resolve_bun(explicit: str | None) -> str:
    bun = explicit or os.environ.get("ARRA_BUN") or shutil.which("bun")
    if not bun:
        raise CopyMigrationFailed("bun not found: set ARRA_BUN or put bun on PATH")
    return bun


def run_worker(candidate_root: Path, gate_fd: int, plan_path: Path, bun: str | None) -> list[dict[str, Any]]:
    argv = [
        sys.executable, "-m", "arra_migrate.copy_migration.adopt_gate", str(gate_fd), str(candidate_root), "--",
        resolve_bun(bun), "run", str(WORKER_SCRIPT), str(plan_path),
    ]
    env = dict(os.environ)
    # The adopting interpreter must import this package even from another cwd.
    src = str(_HERE.parents[2])
    env["PYTHONPATH"] = src + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    try:
        done = subprocess.run(argv, cwd=SERVER_DIR, env=env, pass_fds=(gate_fd,), capture_output=True,
                              timeout=DEADLINE_SECONDS, check=False)
    except subprocess.TimeoutExpired as error:
        raise CopyMigrationFailed(f"knowledge worker exceeded {DEADLINE_SECONDS}s") from error
    if len(done.stdout) > MAX_STDOUT_BYTES:
        raise CopyMigrationFailed("knowledge worker output exceeded its cap")
    if done.returncode != 0:
        tail = done.stderr.decode("utf-8", "replace")[-2000:]
        raise CopyMigrationFailed(f"knowledge worker exited {done.returncode}: {tail}")
    lines = []
    for raw in done.stdout.decode("utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            line = json.loads(raw)
        except ValueError as error:
            raise CopyMigrationFailed(f"knowledge worker printed a non-JSON line: {raw[:200]!r}") from error
        if not isinstance(line, dict):
            raise CopyMigrationFailed("knowledge worker printed a non-object line")
        lines.append(line)
    if not any(line.get("kind") == "done" for line in lines):
        raise CopyMigrationFailed("knowledge worker did not report completion")
    return lines
