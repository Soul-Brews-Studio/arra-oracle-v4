#!/usr/bin/env bash
# Timing census: runs every test file as its OWN `bun test` invocation and
# records wall-clock seconds per file. This is the measurement test.order.ts
# reads to order files and derive test.fast.txt — see test.census.tsv for
# the committed result and its regeneration/staleness notes.
#
# Not part of the normal test scripts. Slow (~18 minutes: 66 files, several
# of them 40-65s each because the real fd-42 writer gate is multi-process
# with real SIGKILL recovery) — run this in a herdr pane or background, not
# a blocking foreground call.
set -uo pipefail
cd "$(dirname "$0")"

# Preflight: a missing node_modules or Python venv makes every file fail in
# under 50ms (module-not-found / missing interpreter), which produces a
# census that LOOKS complete — every row filled in — but is measuring
# nothing but import failure. This happened for real on 2026-09-21: a fresh
# worktree with neither installed produced a "census" summing to ~3s total
# against a known ~712s baseline, and nothing caught it until a human eyeballed
# the numbers. Refuse to run rather than repeat that.
if [ ! -d node_modules ]; then
  echo "test-census.sh: app/server/node_modules missing — run 'bun install' first" >&2
  exit 1
fi
if [ ! -x ../migrate-py/.venv/bin/python ] && [ -z "${ARRA_CONTRACT_PYTHON:-}" ]; then
  echo "test-census.sh: ../migrate-py/.venv missing and ARRA_CONTRACT_PYTHON unset — run 'uv sync' in app/migrate-py first" >&2
  exit 1
fi

OUT=test.census.tsv
TMP=$(mktemp)

FILES=$(find test -name '*.test.ts' | sort)
FILES="$FILES ../cli.test.ts"
NFILES=$(echo "$FILES" | wc -w | tr -d ' ')

for f in $FILES; do
  START=$(date +%s.%N)
  bun test "$f" > /tmp/census-last.log 2>&1
  RC=$?
  END=$(date +%s.%N)
  DUR=$(echo "$END - $START" | bc)
  NPASS=$(grep -oE '[0-9]+ pass' /tmp/census-last.log | tail -1 | grep -oE '[0-9]+')
  NFAIL=$(grep -oE '[0-9]+ fail' /tmp/census-last.log | tail -1 | grep -oE '[0-9]+')
  printf '%s\t%.3f\t%s\t%s\t%s\n' "$f" "$DUR" "$RC" "${NPASS:-0}" "${NFAIL:-0}" | tee -a "$TMP"
done

TOTAL=$(awk -F'\t' '{s+=$2} END{printf "%.1f", s}' "$TMP")
PASS=$(awk -F'\t' '{p+=$4} END{print p}' "$TMP")
FAIL=$(awk -F'\t' '{f+=$5} END{print f}' "$TMP")

echo ""
echo "CENSUS DONE: $NFILES files, ${TOTAL}s summed, $PASS pass / $FAIL fail"

# Sanity check, not eyeballing: a single combined `bun run test:full` run of
# this same suite measured 712.87s on main at 63e1db0 (2026-09-21). Summed
# per-file times here should be MORE than that (each invocation pays its own
# startup separately) but same order of magnitude. If the sum is wildly
# LESS, every file is failing fast (missing deps, see preflight above, or
# something new) and this census is invalid — refuse to let it overwrite a
# good one silently.
BASELINE=712.87
RATIO=$(echo "$TOTAL / $BASELINE" | bc -l)
LOW=$(echo "$RATIO < 0.5" | bc -l)
if [ "$LOW" = "1" ]; then
  echo "test-census.sh: REFUSING to write $OUT — summed time ${TOTAL}s is less than half the ${BASELINE}s combined-run baseline." >&2
  echo "  That is the signature of every file failing fast (missing deps/env), not real measurement. Fix the environment and re-run." >&2
  echo "  Raw (unverified) data left at: $TMP" >&2
  exit 1
fi
if [ "$FAIL" != "0" ]; then
  echo "test-census.sh: NOTE — $FAIL failing test(s) recorded across the run. Not blocking (the suite may have real red tests), but check $TMP before trusting $OUT." >&2
fi

{
  echo "# test.census.tsv — per-file wall-clock time, measured on v4/test-split."
  echo "# Each row is ONE bare-metal \`bun test <file>\` invocation, timed alone (not"
  echo "# inside the shared \`bun test <list-of-files>\` process the normal"
  echo "# \`test\`/\`test:full\` scripts use). That means every row pays its own process"
  echo "# startup + module load + fixture setup that a single combined run amortises —"
  echo "# these numbers are an UPPER BOUND on each file's share of a real run, and they"
  echo "# sum to MORE than a real run's wall clock. Last regeneration: ${TOTAL}s summed"
  echo "# here vs ${BASELINE}s for one combined run of the same file set. Use this file"
  echo "# to ORDER and BUCKET files by relative cost, not to predict absolute suite time."
  echo "#"
  echo "# Columns: path(relative to app/server)  seconds  exit_code  pass_count  fail_count"
  echo "#"
  echo "# Regenerate with ./test-census.sh (~18 minutes). Re-run after adding, removing,"
  echo "# or materially changing test files so test.order.ts's ordering and"
  echo "# test.fast.txt's split stay honest. A file with NO entry here is not silently"
  echo "# ignored: test.order.ts warns on stderr and falls back to the old name-based"
  echo "# isSlow() heuristic for that file only (biased slow), and excludes it from"
  echo "# test.fast.txt until it has a real measurement."
  cat "$TMP"
} > "$OUT"
rm -f "$TMP"

echo "Wrote $OUT. Top 15 slowest:"
grep -v '^#' "$OUT" | sort -t$'\t' -k2 -rn | head -15
