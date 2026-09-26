# Shared helpers for app/just/demo.sh (Nat's "LET PLAY" relic c30e0ba2 #20246;
# overnight ruling R8/R9/R14/R18/R20, docs/overnight/DECISIONS.md).
#
# Sourced by demo.sh, which sets PY (the venv python) and BANK first; CLI
# (an array, `(bun "$APP/cli.ts")`) and ORIGIN are set AFTER this file is
# sourced, once `demo_stack_up` (stack.sh) has a running server -- `run_cli`
# and `mcp_v3_call` are only ever called later, from `demo_kb_loop`/
# `demo_v3_loop`, by which point both exist. Every function here is
# print-first: the demo's whole point is a readable transcript, not a quiet
# pass/fail.
#
# Nothing here opens a dataset or a socket -- that is stack.sh's job.

# Running step counter, purely cosmetic (`== N. description ==` headers).
STEP_N=0

step() {
  STEP_N=$((STEP_N + 1))
  echo
  echo "== ${STEP_N}. $* =="
}

# Echo a command line for the human BEFORE running it. Never hand this a
# real credential: `run_cli`/`mcp_v3_call` build their own redacted line
# instead of accepting one from a caller, so there is exactly one place in
# this whole demo that could leak the token, and it never does. (Fix round:
# the previous comment here claimed this was grepped for in a
# `demo-loop.test.ts` that does not exist -- `demo.test.ts` is this demo's
# only test file, and it makes no token/Bearer assertion of its own; the
# no-argv discipline below is enforced by review, not by CI, until that
# lands.)
show() { echo "+ $*"; }

# One line per verdict, grepped by the bun test (`demo.test.ts`) as this
# demo's success markers -- the same idea as this repo's own PASS/FAIL/GAP
# acceptor lines, just three states instead of three columns.
ok()   { echo "STEP_OK $1"; }
skip() { echo "STEP_SKIPPED $1 ($2)"; }
fail() { echo "STEP_FAIL $1: $2" >&2; exit 1; }

# Best-effort pretty print for the transcript. A CLI usage error or a plain
# health-check body is not JSON at all, so an unparseable line is printed
# unchanged rather than swallowed.
print_json() { echo "$1" | "$PY" -m json.tool 2>/dev/null || echo "$1"; }

# A wire-grammar nanoid21 (`contracts/common.ts`'s `NANOID21`): this demo
# mints its own ids for the same reason the CLI aliases do (`kb.aliases.ts`) --
# several methods here (`registerPeer`, `publishRevision`, `supersedeNode`)
# take a CALLER-supplied id, and `kb <method>` does no id generation of its own.
nid() {
  "$PY" -c "import secrets,string;print(''.join(secrets.choice(string.ascii_letters+string.digits+'_-') for _ in range(21)))"
}

# Read one dotted field out of a JSON string -- `jget "$LAST_OUT" outcome`,
# `jget "$LAST_OUT" result.node_id`. A numeric path segment indexes a list.
# This repo has no jq dependency (`rg jq app/just` = 0 hits), so this is
# python3, exactly like every other script in app/just/scripts/.
jget() {
  "$PY" -c "
import json, sys
value = json.loads(sys.argv[1])
for key in sys.argv[2].split('.'):
    value = value[int(key)] if isinstance(value, list) else value[key]
print(value if isinstance(value, str) else json.dumps(value))
" "$1" "$2"
}

# True (exit 0) when `$1` looks like a governed failure envelope: a top-level
# "error" or code:"..." field. Used to decide STEP_OK vs STEP_FAIL after a
# call that does not go through the CLI's own exit-code convention (the raw
# v3 MCP calls in v3.sh parse `result.isError` themselves instead).
looks_like_error() {
  "$PY" -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(d, dict) and (d.get('error') is not None or 'code' in d) else 1)
" "$1"
}

# Run one `bun app/cli.ts <args...>` call, print its argv (safe: the token
# travels only via the ARRA_TOKEN env var, never argv or stdout) and its
# pretty-printed output, and leave the RAW (unpretty) body in $LAST_OUT and
# its exit code in $LAST_RC for the caller to inspect with `jget`.
run_cli() {
  show "bun app/cli.ts $*"
  local out rc
  out="$("${CLI[@]}" "$@" 2>&1)"
  rc=$?
  LAST_OUT="$out"
  LAST_RC=$rc
  print_json "$out"
  echo
  return "$rc"
}

# Is a local (or stubbed) Ollama actually answering? `DEMO_OLLAMA_URL`
# overrides everything -- the bun stub test points it at a `Bun.serve` stub
# so CI never depends on, or silently skips past, a real model. Absent that,
# this follows the exact same `OLLAMA_URL` fallback embed.ts and chat-model
# already use, so "is Ollama up" here means the same thing it means to the
# server this script is about to start.
resolve_ollama() {
  OLLAMA_BASE="${DEMO_OLLAMA_URL:-${OLLAMA_URL:-http://127.0.0.1:11434}}"
  if curl -fsS -m 2 "$OLLAMA_BASE/api/tags" >/dev/null 2>&1; then
    OLLAMA_UP=1
  else
    OLLAMA_UP=0
  fi
}
