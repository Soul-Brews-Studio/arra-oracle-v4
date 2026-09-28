#!/usr/bin/env bash
# Shared by `just up` and dev-stack.sh (R32, docs/overnight/DECISIONS.md):
# create BOTH a legacy-15 root and a target-19 knowledge root, idempotently.
#
# Usage: create-both-roots.sh <legacy-root> <knowledge-root>
#
# - <legacy-root>    gets `arra_migrate --legacy-active15` (serves
#                    /api/memories and startup FTS via ARRA_DATA_DIR).
# - <knowledge-root> gets the bare `arra_migrate` (target-19) plus the
#                    workspace seed create_target19_dataset.py (serves
#                    /api/knowledge/* via ARRA_KNOWLEDGE_DATASET_ROOT).
#
# Re-running is safe: arra_migrate only creates tables that are absent, and
# create_target19_dataset.py refuses (exit 1, nothing deleted) rather than
# reseed a workspace row that already exists. The migrator itself refuses a
# root that holds the OTHER registry's tables -- this script does not paper
# over that, it surfaces the exit code.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <legacy-root> <knowledge-root>" >&2
  exit 64
fi

LDATA="$1"
KDATA="$2"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
PY="$APP/migrate-py/.venv/bin/python"
SCRIPTS="$HERE"

mkdir -p "$LDATA" "$KDATA"

echo "== legacy-15 dataset ($LDATA) =="
ARRA_DATA_DIR="$LDATA" "$PY" -m arra_migrate --legacy-active15

echo "== target19 dataset ($KDATA) =="
ARRA_DATA_DIR="$KDATA" "$PY" -m arra_migrate
# The tables now exist, so create_target19_dataset.py only seeds the
# 'default' workspace row (no transport creates one). It refuses (exit 1,
# nothing deleted) rather than seed on top of an existing 'default'
# workspace row whose created_at is sub-millisecond (#75/#105, R1).
if ! "$PY" "$SCRIPTS/create_target19_dataset.py" "$KDATA"; then
  echo "== ABORTED: $KDATA has a sub-millisecond default workspace created_at ==" >&2
  echo "   This dataset predates the R1 fix, or was corrupted some other way." >&2
  echo "   Regenerate it -- nothing here was deleted automatically:" >&2
  echo "     rm -rf \"$KDATA\"" >&2
  exit 1
fi
