# The fresh mktemp stack demo.sh runs against: target19 + legacy15 datasets,
# a dev auth policy/token, and the server started through the writer gate
# (`run_dev_server.py` -> `arra_migrate.writer_gate.exec_with_gate`) exactly
# the way `dev-stack.sh` does it -- except everything here lives under a
# fresh `mktemp -d`, never under `app/.tmp/` (hard rule: this demo must never
# touch `app/.tmp`, `app/data`, `~/` or a running service), and the server's
# port is a free ephemeral one, not the fixed 3939 a real dev-stack may
# already be holding.
#
# Sourced by demo.sh, which sets: PY, APP, SRV, SCRIPTS, BANK first.
# Exports on success: ROOT, KDATA, LDATA, POLICY, TOKEN, PORT, ORIGIN,
# ARRA_URL/ARRA_BANK/ARRA_TOKEN (consumed by app/cli.ts), SERVER_PID.

demo_stack_up() {
  step "fresh mktemp stack: target19 + legacy15 + dev policy"

  ROOT="$(mktemp -d "${TMPDIR:-/tmp}/arra-demo.XXXXXX")"
  KDATA="$ROOT/dataset"   # target19 -- serves /api/knowledge/* and kb_*
  LDATA="$ROOT/legacy"    # legacy15 -- serves /api/memories, startup FTS, mcp_calls/connections
  mkdir -p "$KDATA" "$LDATA"
  show "mktemp -d  ->  $ROOT"

  show "ARRA_DATA_DIR=$LDATA $PY -m arra_migrate"
  ARRA_DATA_DIR="$LDATA" "$PY" -m arra_migrate || fail "dataset-create" "arra_migrate (legacy15) exited non-zero"
  echo

  show "$PY app/just/scripts/create_target19_dataset.py $KDATA"
  "$PY" "$SCRIPTS/create_target19_dataset.py" "$KDATA" \
    || fail "dataset-create" "create_target19_dataset.py exited non-zero"
  echo
  ok "dataset-create"

  show "$PY app/just/scripts/write_dev_policy.py $ROOT $BANK demo-operator"
  "$PY" "$SCRIPTS/write_dev_policy.py" "$ROOT" "$BANK" "demo-operator" >/dev/null \
    || fail "dev-policy" "write_dev_policy.py exited non-zero"
  POLICY="$ROOT/dev-policy.json"
  TOKEN="$(cat "$ROOT/dev-token.txt")"
  echo "policy: $POLICY"
  echo "token:  (never printed -- see app/cli.ts's own rule)"
  ok "dev-policy"

  PORT="$("$PY" -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')"
  ORIGIN="http://127.0.0.1:$PORT"

  step "start the server through the writer gate on a free port ($PORT)"
  local log="$ROOT/server.log"
  show "ARRA_AUTH_POLICY=... ARRA_ORIGIN=$ORIGIN PORT=$PORT ARRA_KNOWLEDGE_DATASET_ROOT=$KDATA ARRA_MCP_V3_COMPAT=1 \\"
  show "  $PY app/just/scripts/run_dev_server.py $KDATA app/server   (log: $log)"
  (
    export ARRA_AUTH_POLICY="$POLICY"
    export ARRA_ORIGIN="$ORIGIN"
    export PORT="$PORT"
    export ARRA_DATA_DIR="$LDATA"
    export ARRA_KNOWLEDGE_DATASET_ROOT="$KDATA"
    # R18 D10: v3-compatible oracle_* tools, on for this demo's MCP steps.
    export ARRA_MCP_V3_COMPAT=1
    # `DEMO_OLLAMA_URL` (the bun stub test) or a real local Ollama; propagated
    # to BOTH the #30 embedder (embed.ts's OLLAMA_URL) and #32 chat
    # (chat-model's ARRA_CHAT_URL, which itself defaults to OLLAMA_URL) --
    # setting one covers both, matching how they are already documented to
    # share it.
    export OLLAMA_URL="$OLLAMA_BASE"
    exec "$PY" "$SCRIPTS/run_dev_server.py" "$KDATA" "$SRV"
  ) >"$log" 2>&1 &
  SERVER_PID=$!
  disown

  local waited=0
  until curl -fsS "$ORIGIN/health" >/dev/null 2>&1; do
    sleep 0.2
    waited=$((waited + 1))
    if [ "$waited" -gt 150 ]; then
      echo "--- server.log (last 40 lines) ---" >&2
      tail -n 40 "$log" >&2 || true
      fail "server-start" "server did not answer /health within 30s (pid $SERVER_PID)"
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "--- server.log (last 60 lines) ---" >&2
      tail -n 60 "$log" >&2 || true
      fail "server-start" "server process exited before answering /health"
    fi
  done
  show "curl $ORIGIN/health"
  print_json "$(curl -fsS "$ORIGIN/health")"
  echo
  ok "server-start"

  export ARRA_URL="$ORIGIN"
  export ARRA_BANK="$BANK"
  export ARRA_TOKEN="$TOKEN"
}

# Always runs (demo.sh traps this on EXIT): stop the server, then remove the
# entire mktemp stack. `kill -TERM` on the bun PID both stops the process and
# releases fd 42 (the writer-gate flock) the same way any owned-process death
# does -- there is nothing left to unlock separately.
demo_stack_down() {
  step "stop server and remove the mktemp stack"
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    show "kill -TERM $SERVER_PID"
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 25); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$SERVER_PID" 2>/dev/null && kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "${ROOT:-}" ]; then
    show "rm -rf $ROOT"
    rm -rf -- "$ROOT"
  fi
  ok "stack-down"
}
