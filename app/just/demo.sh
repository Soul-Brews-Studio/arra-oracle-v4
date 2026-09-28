#!/usr/bin/env bash
# arra-oracle-v4 end-to-end demo -- the one Nat asked for and never got
# (relic c30e0ba2 #20246, 2026-09-21: "make all finished today! but today
# done implement embeded FULL TEST CLI FIRST LET PLAY LET MEMORY INDEX
# LANCEDB"). One command, real stack, real transports, real local models:
#
#   bash app/just/demo.sh
#
# What it does, in order (docs/overnight/DEMO.md is a captured transcript of
# a real run, with a paragraph of explanation per step):
#   1. A fresh mktemp stack: a target19 dataset (create_target19_dataset.py),
#      a legacy15 dataset (arra_migrate --legacy-active15), a dev auth policy + token
#      (write_dev_policy.py) -- same building blocks as `dev-stack.sh`, but
#      isolated under mktemp, never app/.tmp, and on a free port.
#   2. The server, started through the writer gate (run_dev_server.py),
#      with the v3-compatible MCP family on (ARRA_MCP_V3_COMPAT=1).
#   3. The daily loop over the REAL CLI (`bun app/cli.ts`, friendly aliases
#      and the generic `kb <method>`, #31 R8): peers, a session, EN + Thai
#      messages, a published knowledge node with a reserved type term,
#      indexing, embedding with the real local Ollama `all-minilm` (R20),
#      keyword + semantic search, getContext, chat with the real local
#      Ollama `gemma3:4b` (R9), and a supersede/history round trip (#29 R7).
#   4. The v3 adapter loop over the REAL MCP endpoint (raw JSON-RPC via
#      curl, ARRA_MCP_V3_COMPAT=1): tools/list, oracle_learn, oracle_search,
#      oracle_thread + oracle_thread_read (speaker via X-Arra-Peer).
#   5. ALWAYS stops the server and removes the mktemp stack (trap on EXIT,
#      whether this script succeeds, fails, or is interrupted).
#
# If Ollama is not reachable (real or, in `demo.test.ts`'s stub run, at
# $DEMO_OLLAMA_URL), the model-dependent steps (embed, semantic search, chat)
# print an explicit `STEP_SKIPPED ...` line instead of faking output; every
# other step still runs for real. `demo.test.ts` asserts every step's
# `STEP_OK` / `STEP_SKIPPED` marker, so CI keeps this demo honest with no
# model required.
#
# Helpers live in app/just/demo/*.sh (this file stays a short orchestrator):
#   lib.sh    print/step/json helpers shared by everything below
#   stack.sh  the mktemp dataset + gated server, up and down
#   loop.sh   the CLI-driven knowledge loop
#   v3.sh     the raw-MCP v3 adapter loop
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
SRV="$APP/server"
PY="$APP/migrate-py/.venv/bin/python"
SCRIPTS="$HERE/scripts"
DEMO_DIR="$HERE/demo"

BANK="default"        # create_target19_dataset.py seeds exactly this workspace
PEER_ALICE="alice"
PEER_BOB="bob"
SESSION="daily-loop"

# shellcheck source=/dev/null
source "$DEMO_DIR/lib.sh"
# shellcheck source=/dev/null
source "$DEMO_DIR/stack.sh"
# shellcheck source=/dev/null
source "$DEMO_DIR/loop.sh"
# shellcheck source=/dev/null
source "$DEMO_DIR/v3.sh"

echo "arra-oracle-v4 demo -- $(date -u +%Y-%m-%dT%H:%M:%SZ)"
resolve_ollama
if [ "$OLLAMA_UP" -eq 1 ]; then
  echo "Ollama reachable at $OLLAMA_BASE -- embed/semantic-search/chat run for real."
else
  echo "Ollama UNREACHABLE at $OLLAMA_BASE -- embed/semantic-search/chat will print STEP_SKIPPED, nothing faked."
fi

# ALWAYS stops the server and removes the mktemp stack, on success, on a
# failed step (`fail()` calls `exit 1`), or on an interrupt.
cleanup() {
  local rc=$?
  demo_stack_down
  [ "$rc" -eq 0 ] && { echo; echo "DEMO_DONE"; }
  exit "$rc"
}
trap cleanup EXIT
# Fix round (nonblocking finding): without an explicit handler, an INT/TERM
# delivered to this script does not reliably leave `$?` non-zero by the time
# the EXIT trap above reads it -- observed printing `STEP_OK stack-down` AND
# `DEMO_DONE` after a `kill -TERM`, even though the run was interrupted, not
# finished. Cleanup itself (stopping the server, removing the mktemp root)
# already ran correctly either way; only the "it finished" claim was wrong.
# `exit N` here still runs through the EXIT trap above, now with the
# conventional 128+signal status so `[ "$rc" -eq 0 ]` correctly says no.
trap 'exit 130' INT
trap 'exit 143' TERM

demo_stack_up
CLI=(bun "$APP/cli.ts")

demo_kb_loop
demo_v3_loop
