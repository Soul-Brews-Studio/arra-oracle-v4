"""Hand the orchestrator's HELD writer gate to the Bun worker, then exec it.

    python -m arra_migrate.copy_migration.adopt_gate <fd> <root> -- <argv...>

The orchestrator holds ``writer_gate(candidate)`` for the WHOLE migration and
passes that descriptor to this process with ``pass_fds``. Here it is moved to
the protocol's fixed descriptor 42 and the process is replaced by the worker.
Both processes then share ONE open file description, which is what carries
the flock -- the lock is never released and re-taken between the Python and
Bun phases, so no other writer can slip in between them.

This differs from ``writer_gate.exec_with_gate`` only in that it ADOPTS a lock
already held instead of taking a new one (a second flock from a second open
would fail against our own holder). The TS side verifies the descriptor
exactly as it does for ``exec_with_gate`` (``storage.assertInheritedGate``).
"""

from __future__ import annotations

import os
import sys

from ..writer_gate import ENV_FD, ENV_ROOT, INHERITED_FD, canonical_dataset_root


def main(argv: list[str]) -> None:
    if len(argv) < 5 or argv[3] != "--":
        raise SystemExit("usage: adopt_gate <fd> <root> -- <argv...>")
    held = int(argv[1])
    root = canonical_dataset_root(argv[2])
    command = argv[4:]
    os.dup2(held, INHERITED_FD, inheritable=True)
    if held != INHERITED_FD:
        os.close(held)
    env = dict(os.environ)
    env[ENV_FD] = str(INHERITED_FD)
    env[ENV_ROOT] = str(root)
    os.execvpe(command[0], command, env)


if __name__ == "__main__":
    main(sys.argv)
