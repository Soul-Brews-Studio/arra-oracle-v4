#!/usr/bin/env bash
# Local dev convenience: bring up arra-oracle-v4 on 127.0.0.1:3939 with a
# target19 dataset the /api/knowledge/* routes can open, plus a legacy-15
# dataset for the existing /api/memories (#25) routes and startup FTS index
# work -- both created fresh under app/.tmp/, never touching app/data.
#
# One command:  app/just/dev-stack.sh
#
# Idempotent: re-running reuses an existing dataset/policy/token instead of
# recreating them. The server is started in the background (nohup) because
# this script is meant to be run once and left running; see app/.tmp/DEV-STACK.md
# for the token, PID file and how to stop it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
SRV="$APP/server"
PY="$APP/migrate-py/.venv/bin/python"
SCRIPTS="$HERE/scripts"
TMP="$APP/.tmp"

KDATA="$TMP/dev-dataset"          # target19 -- serves /api/knowledge/*
LDATA="$TMP/dev-data-legacy"      # active15 -- serves /api/memories, startup FTS
POLICY="$TMP/dev-policy.json"
LOG="$TMP/dev-server.log"
PIDFILE="$TMP/dev-server.pid"
PORT="${PORT:-3939}"
WORKSPACE="default"
PRINCIPAL="dev-operator"

mkdir -p "$TMP" "$KDATA" "$LDATA"

# R32 (docs/overnight/DECISIONS.md): the bare migrator creates target19; the
# legacy 15 need the explicit flag. The server still opens `memories` in
# ARRA_DATA_DIR for /api/memories and startup FTS, so both datasets stay.
echo "== legacy-15 dataset ($LDATA) =="
ARRA_DATA_DIR="$LDATA" "$PY" -m arra_migrate --legacy-active15

echo "== target19 dataset ($KDATA) =="
ARRA_DATA_DIR="$KDATA" "$PY" -m arra_migrate
# The tables now exist, so create_target19_dataset.py only seeds the
# 'default' workspace row (no transport creates one). It itself refuses (exit 1, nothing deleted) rather
# than seed on top of an existing 'default' workspace row whose created_at is
# sub-millisecond (#75/#105 -- see docs/overnight/DECISIONS.md R1). Give the
# operator the exact dev-stack remedy here rather than only the script's
# generic dataset_root message.
if ! "$PY" "$SCRIPTS/create_target19_dataset.py" "$KDATA"; then
  echo "== ABORTED: $KDATA has a sub-millisecond default workspace created_at ==" >&2
  echo "   This dataset predates the R1 fix, or was corrupted some other way." >&2
  echo "   Regenerate it -- nothing here was deleted automatically:" >&2
  echo "     rm -rf \"$KDATA\" && \"$0\"" >&2
  exit 1
fi

echo "== dev policy =="
"$PY" "$SCRIPTS/write_dev_policy.py" "$TMP" "$WORKSPACE" "$PRINCIPAL"
TOKEN="$(cat "$TMP/dev-token.txt")"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "== server already running (pid $(cat "$PIDFILE")) =="
else
  echo "== starting server on 127.0.0.1:$PORT =="
  ARRA_AUTH_POLICY="$POLICY" \
  ARRA_ORIGIN="${ARRA_ORIGIN:-http://127.0.0.1:$PORT}" \
  PORT="$PORT" \
  ARRA_DATA_DIR="$LDATA" \
  ARRA_KNOWLEDGE_DATASET_ROOT="$KDATA" \
  nohup "$PY" "$SCRIPTS/run_dev_server.py" "$KDATA" "$SRV" >"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  disown

  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health?bank=$WORKSPACE" -H "authorization: Bearer $TOKEN" >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
fi

echo "== health =="
# /api/health is diagnostics:read-gated and requires an explicit ?bank= --
# there is no bank-less "just tell me it's alive" variant.
curl -fsS "http://127.0.0.1:$PORT/api/health?bank=$WORKSPACE" -H "authorization: Bearer $TOKEN"
echo

echo "== seeding workspace content (peers, session, messages) via the API =="
# requireNanoid21 (app/server/src/contracts/common.ts) wants exactly 21 chars
# of [A-Za-z0-9_-]; generate fresh ones each run rather than hand-count literals.
nid() { "$PY" -c "import secrets,string;print(''.join(secrets.choice(string.ascii_letters+string.digits+'_-') for _ in range(21)))"; }

if ! curl -fsS -X POST "http://127.0.0.1:$PORT/api/knowledge/$WORKSPACE/getSession" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"workspace_name\":\"$WORKSPACE\",\"session_name\":\"sess-a\"}" 2>/dev/null | grep -q '"name":"sess-a"'; then
  PEER_A="$(nid)"; PEER_B="$(nid)"; SESS_A="$(nid)"
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/knowledge/$WORKSPACE/registerPeer" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"$WORKSPACE\",\"peer_id\":\"$PEER_A\",\"name\":\"alice\"}" >/dev/null
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/knowledge/$WORKSPACE/registerPeer" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"$WORKSPACE\",\"peer_id\":\"$PEER_B\",\"name\":\"bob\"}" >/dev/null
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/knowledge/$WORKSPACE/registerSession" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"$WORKSPACE\",\"session_id\":\"$SESS_A\",\"name\":\"sess-a\"}" >/dev/null
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/knowledge/$WORKSPACE/joinSession" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"$WORKSPACE\",\"session_name\":\"sess-a\",\"peer_name\":\"alice\"}" >/dev/null
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/knowledge/$WORKSPACE/joinSession" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"$WORKSPACE\",\"session_name\":\"sess-a\",\"peer_name\":\"bob\"}" >/dev/null

  MSGS='[]'
  for i in 1 2 3 4 5; do
    PID="$(nid)"
    who="alice"; [ $((i % 2)) -eq 0 ] && who="bob"
    MSGS="$("$PY" -c "import json,sys; items=json.loads('$MSGS'); items.append({'public_id':'$PID','message':{'peer_name':'$who','role':'user' if '$who'=='alice' else 'assistant','content':'dev seed message $i','in_reply_to':None},'source':None}); print(json.dumps(items))")"
  done
  BODY="$("$PY" -c "import json; print(json.dumps({'workspace_name':'$WORKSPACE','session_name':'sess-a','items':json.loads('$MSGS')}))")"
  curl -fsS -X POST "http://127.0.0.1:$PORT/api/knowledge/$WORKSPACE/appendMessages" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "$BODY" >/dev/null
  echo "seeded  peers alice/bob, session sess-a, 5 messages"
else
  echo "ok      sess-a already seeded"
fi

echo "== token: $TOKEN =="
echo "== done: GET http://127.0.0.1:$PORT/api/health, POST /api/knowledge/$WORKSPACE/listMessages =="
