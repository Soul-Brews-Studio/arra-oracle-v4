#!/usr/bin/env bash
# THE merge and release gate (R23, docs/overnight/DECISIONS.md): every step of
# .github/workflows/ci.yml, run locally, in the same order. GitHub Actions
# stopped on 2026-09-27 ("recent account payments have failed or your spending
# limit needs to be increased"), and Nat ruled on 2026-09-28: use only local.
#
#   bash app/just/local-ci.sh              # this checkout
#   bash app/just/local-ci.sh <checkout>   # another worktree
#
# Prints one line per step (its exit code and name), then
# LOCAL_CI_RESULT PASS|FAIL. Exit code 0 only when every step passed. Keep it
# in step with ci.yml: a step added there must be added here.
set -uo pipefail
W="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
declare -a RESULTS=()
step() { local name="$1"; shift; echo; echo "=== $name ==="; "$@"; local rc=$?; RESULTS+=("$rc $name"); echo "--- $name rc=$rc"; }

step "bun install (app/server, frozen)"   bash -c "cd '$W/app/server' && bun install --frozen-lockfile >/dev/null"
step "bun install (app/ui/v2, frozen)"    bash -c "cd '$W/app/ui/v2' && bun install --frozen-lockfile >/dev/null"
step "uv sync (app/migrate-py, frozen)"   bash -c "cd '$W' && uv sync --project app/migrate-py --frozen >/dev/null 2>&1"
step "Lint (ruff 0.16.4, migrate-py + just/scripts)" bash -c "cd '$W' && uvx ruff@0.16.4 check app/migrate-py/src app/migrate-py/tests app/just/scripts"
step "Typecheck (app/server)"             bash -c "cd '$W/app/server' && bun run typecheck"
step "Build (app/server)"                 bash -c "cd '$W/app/server' && bun run build >/dev/null"
step "Test: sharded full suite"           bash -c "cd '$W/app/server' && TEST_SHARDS=4 TEST_TIMEOUT_MS=60000 TEST_TIME_SCALE=5 bun run test:parallel 2>&1 | grep -E 'PARALLEL|pass,|fail|shard [0-9]+:' | tail -12; exit \${PIPESTATUS[0]}"
step "Test: demo.test.ts (stub Ollama)"   bash -c "cd '$W/app' && TEST_TIME_SCALE=5 bun test just/demo.test.ts 2>&1 | tail -3; exit \${PIPESTATUS[0]}"
step "Test: ui-e2e harness rules"         bash -c "cd '$W/app' && bun test just/ui-e2e.test.ts 2>&1 | tail -3; exit \${PIPESTATUS[0]}"
step "Test: Python migrate-py discover"   bash -c "cd '$W/app/migrate-py' && PYTHONPATH=src .venv/bin/python -m unittest discover -s tests 2>&1 | grep -E '^(Ran|OK|FAILED)'; exit \${PIPESTATUS[0]}"
step "Test: Python fixture suites"        bash -c "cd '$W/app/migrate-py' && PYTHONPATH=src:tests .venv/bin/python -W error::ResourceWarning tests/fixtures/publication-v1/test_export_publication_fixture.py >/dev/null 2>&1 && PYTHONPATH=src:tests .venv/bin/python -W error::ResourceWarning tests/fixtures/taxonomy-v1/test_export_taxonomy_fixture.py >/dev/null 2>&1"
step "Test: Python benchmarks"            bash -c "cd '$W/app/benchmarks' && ../migrate-py/.venv/bin/python -m unittest discover -s . -p 'test_*.py' 2>&1 | grep -E '^(Ran|OK|FAILED)'; exit \${PIPESTATUS[0]}"
step "Typecheck UI v2"                    bash -c "cd '$W/app/ui/v2' && ./node_modules/.bin/tsc -p tsconfig.json"
step "Test: UI v2 (bun test src)"         bash -c "cd '$W/app/ui/v2' && bun test src 2>&1 | tail -3; exit \${PIPESTATUS[0]}"
step "Build UI v2"                        bash -c "cd '$W/app/ui/v2' && bun run build >/dev/null 2>&1"
step "Committed UI bundle matches source" bash -c "cd '$W' && test -z \"\$(git status --porcelain app/server/public/v2)\""

echo; echo "=== LOCAL CI SUMMARY ($(git -C "$W" rev-parse --short HEAD)) ==="
FAILS=0; for r in "${RESULTS[@]}"; do echo "$r"; [ "${r%% *}" = "0" ] || FAILS=$((FAILS+1)); done
echo "LOCAL_CI_RESULT $([ $FAILS -eq 0 ] && echo PASS || echo FAIL) failed_steps=$FAILS"
[ $FAILS -eq 0 ]
