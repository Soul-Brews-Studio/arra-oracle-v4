"""#34 copy migration: legacy-15 source -> NEW target-19 candidate, on a copy.

Operator-only tooling (rulings R11 + R17, docs/overnight/DECISIONS.md). It is
never exposed over HTTP, MCP or ``app/cli.ts``; its entry point is the
separate ``arra-migrate-copy`` script, and the production migrator
(``arra_migrate.__main__``) does not import it.

This package is a DELIBERATE consumer of the ``target_v1`` candidate registry:
it creates the 19 target tables in a fresh, empty directory it holds the
writer gate on. See ``run.py`` for the step list.
"""

from .run import main, run_copy_migration
from .snapshot import CopyMigrationRefused
from .worker import CopyMigrationFailed

__all__ = ["CopyMigrationFailed", "CopyMigrationRefused", "main", "run_copy_migration"]
