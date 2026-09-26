#!/usr/bin/env bash
# Live proof for #75 / R2 (docs/overnight/DECISIONS.md).
#
# Runs the REAL server (real HTTP, real writer gate via
# `arra_migrate.writer_gate.exec_with_gate`, real LanceDB dataset) on TWO
# freshly `mktemp -d` datasets:
#
#   new-fixed-script  -- built by the CURRENT (R1-fixed) create_target19_dataset.py
#   old-preR1-script  -- built by that script's content AT the overnight base
#                        commit (be2d9ab), i.e. before R1 truncated created_at
#
# On each, it seeds a peer + session + membership over HTTP (registerPeer,
# registerSession, joinSession, appendMessages), then calls getReadCursor,
# advanceReadCursor and getReadCursor again over HTTP -- recording every
# response. The fixed dataset is expected to succeed throughout; the
# pre-R1 dataset is expected to fail closed with `integrity_failure` at
# `getReadCursor` (the exact #75 symptom), because its seeded workspace
# `created_at` carries genuine microsecond precision.
#
# Never touches app/.tmp, app/data or any other running service: every path
# used here lives under one `mktemp -d` this script owns and removes.
#
# THE OLD-SCRIPT LEG IS PROBABILISTIC, on purpose: it runs the actual
# pre-fix code, which seeds `datetime.now(timezone.utc)` -- about 999 times
# in 1000 that lands on a non-zero microsecond remainder and reproduces the
# failure live. (The companion pytest, test_dev_seed_dataset.py, is what
# makes the regression check deterministic; this script is the live/HTTP
# proof, not the unit gate.) A coincidentally-aligned instant here would
# make this leg pass instead of fail -- which the summary line makes visible
# rather than silently ignoring.
#
# Usage:  app/server/test/fixtures/read-cursor-v1/live-r2/run.sh
set -uo pipefail   # deliberately not -e: the two legs' expected outcomes differ and are checked explicitly

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
APP="$REPO/app"
SRV="$APP/server"
PY="$APP/migrate-py/.venv/bin/python"
SCRIPTS="$APP/just/scripts"
BASE_SHA="be2d9ab"   # v4/overnight-26sep base -- pre-R1 create_target19_dataset.py

ROOT="$(mktemp -d)"
OLDSCRIPT="$ROOT/create_target19_dataset.OLD.py"
git -C "$REPO" show "$BASE_SHA:app/just/scripts/create_target19_dataset.py" >"$OLDSCRIPT" 2>"$ROOT/git-show.err"
if [[ ! -s "$OLDSCRIPT" ]]; then
  echo "could not extract the pre-R1 script from $BASE_SHA -- is that SHA reachable here?" >&2
  cat "$ROOT/git-show.err" >&2
  rm -rf -- "$ROOT"
  exit 2
fi

SERVER_PID=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf -- "$ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

nid() { "$PY" -c "import secrets,string;print(''.join(secrets.choice(string.ascii_letters+string.digits+'_-') for _ in range(21)))"; }

# $1 = label  $2 = dataset-creator script path  $3 = expect: "ok" | "integrity_failure"
run_leg() {
  local label="$1" creator="$2" expect="$3"
  local leg="$ROOT/$label"
  local kdata="$leg/target19" ldata="$leg/legacy15" out="$leg/out"
  mkdir -p "$kdata" "$ldata" "$out"

  echo "=================================================================="
  echo "=== $label  (expect: $expect) ==="
  echo "=================================================================="
  echo "-- legacy15 dataset --"
  ARRA_DATA_DIR="$ldata" "$PY" -m arra_migrate || { echo "$label: legacy15 create FAILED"; return 1; }

  echo "-- target19 dataset via $creator --"
  if ! "$PY" "$creator" "$kdata"; then
    echo "$label: dataset creator FAILED unexpectedly (both scripts are expected to seed successfully; only the READ-CURSOR calls below are expected to differ)"
    return 1
  fi

  echo "-- dev policy --"
  "$PY" "$SCRIPTS/write_dev_policy.py" "$leg" default "dev-operator-$label" || return 1
  local token; token="$(cat "$leg/dev-token.txt")"

  local port up=""
  for attempt in 1 2 3; do
    port=$(( (RANDOM % 20000) + 20000 ))
    echo "-- starting real server, writer-gated, on 127.0.0.1:$port (attempt $attempt) --"
    ARRA_AUTH_POLICY="$leg/dev-policy.json" \
    ARRA_ORIGIN="http://127.0.0.1:$port" \
    PORT="$port" \
    ARRA_DATA_DIR="$ldata" \
    ARRA_KNOWLEDGE_DATASET_ROOT="$kdata" \
    "$PY" "$SCRIPTS/run_dev_server.py" "$kdata" "$SRV" >"$leg/server.log" 2>&1 &
    SERVER_PID=$!

    for _ in $(seq 1 100); do
      if curl -fsS "http://127.0.0.1:$port/api/health?bank=default" -H "authorization: Bearer $token" >/dev/null 2>&1; then up=1; break; fi
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
      sleep 0.1
    done
    [[ -n "$up" ]] && break
    kill -TERM "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
  done
  if [[ -z "$up" ]]; then
    echo "$label: server never came up after 3 attempts"; tail -40 "$leg/server.log"
    return 1
  fi

  local peer="alice-$label" session="sess-$label" peer_id session_id msgid
  peer_id="$(nid)"; session_id="$(nid)"; msgid="$(nid)"

  curl -fsS -X POST "http://127.0.0.1:$port/api/knowledge/default/registerPeer" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"default\",\"peer_id\":\"$peer_id\",\"name\":\"$peer\"}" >"$out/registerPeer.json"
  echo "registerPeer: $(cat "$out/registerPeer.json")"

  curl -fsS -X POST "http://127.0.0.1:$port/api/knowledge/default/registerSession" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"default\",\"session_id\":\"$session_id\",\"name\":\"$session\"}" >"$out/registerSession.json"
  echo "registerSession: $(cat "$out/registerSession.json")"

  curl -fsS -X POST "http://127.0.0.1:$port/api/knowledge/default/joinSession" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"default\",\"session_name\":\"$session\",\"peer_name\":\"$peer\"}" >"$out/joinSession.json"
  echo "joinSession: $(cat "$out/joinSession.json")"

  local get1_status
  get1_status="$(curl -sS -o "$out/getReadCursor.before.json" -w '%{http_code}' \
    -X POST "http://127.0.0.1:$port/api/knowledge/default/getReadCursor" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"default\",\"peer_name\":\"$peer\",\"session_name\":\"$session\"}")"
  echo "getReadCursor (before advance): HTTP $get1_status -- $(cat "$out/getReadCursor.before.json")"

  curl -fsS -X POST "http://127.0.0.1:$port/api/knowledge/default/appendMessages" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"default\",\"session_name\":\"$session\",\"items\":[{\"public_id\":\"$msgid\",\"message\":{\"peer_name\":\"$peer\",\"role\":\"user\",\"content\":\"hi\",\"in_reply_to\":null},\"source\":null}]}" \
    >"$out/appendMessages.json"
  echo "appendMessages: $(cat "$out/appendMessages.json")"

  local adv_status
  adv_status="$(curl -sS -o "$out/advanceReadCursor.json" -w '%{http_code}' \
    -X POST "http://127.0.0.1:$port/api/knowledge/default/advanceReadCursor" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"default\",\"peer_name\":\"$peer\",\"session_name\":\"$session\",\"last_read_message_id\":\"$msgid\",\"expected\":null}")"
  echo "advanceReadCursor: HTTP $adv_status -- $(cat "$out/advanceReadCursor.json")"

  local get2_status
  get2_status="$(curl -sS -o "$out/getReadCursor.after.json" -w '%{http_code}' \
    -X POST "http://127.0.0.1:$port/api/knowledge/default/getReadCursor" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"workspace_name\":\"default\",\"peer_name\":\"$peer\",\"session_name\":\"$session\"}")"
  echo "getReadCursor (after advance): HTTP $get2_status -- $(cat "$out/getReadCursor.after.json")"

  kill -TERM "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""

  case "$expect" in
    ok)
      if [[ "$get1_status" == "200" && "$adv_status" == "200" && "$get2_status" == "200" ]]; then
        echo "$label: PASS -- getReadCursor/advanceReadCursor/getReadCursor all 200"
        return 0
      fi
      echo "$label: FAIL -- expected 200/200/200, got $get1_status/$adv_status/$get2_status"
      return 1
      ;;
    integrity_failure)
      if [[ "$get1_status" == "500" ]] && grep -q '"integrity_failure"' "$out/getReadCursor.before.json"; then
        echo "$label: PASS -- getReadCursor failed closed with integrity_failure, as #75 reported"
        return 0
      fi
      echo "$label: FAIL -- expected HTTP 500 integrity_failure at getReadCursor, got HTTP $get1_status"
      return 1
      ;;
  esac
}

overall=0
run_leg "new-fixed-script" "$SCRIPTS/create_target19_dataset.py" ok || overall=1
echo
run_leg "old-preR1-script" "$OLDSCRIPT" integrity_failure || overall=1

echo
echo "=================================================================="
if [[ "$overall" -eq 0 ]]; then
  echo "SUMMARY: both legs matched their expectation (fixed dataset works, pre-R1 dataset fails closed)"
else
  echo "SUMMARY: at least one leg did NOT match its expectation -- see above"
fi
echo "=================================================================="
exit "$overall"
