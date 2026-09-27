#!/usr/bin/env bash
# arra-oracle-v4 browser end-to-end test for #33 (AC1, AC3, AC4): the BUILT
# v2 UI, a real gated server on a fresh mktemp dataset, real API writes, no
# mocks. Local only -- it needs `ego-browser` (the one browser allowed on this
# fleet), which CI does not have.
#
#   bash app/just/ui-e2e.sh [OUT_DIR]
#
# OUT_DIR receives the screenshots (e2e-*.png) and transcript.txt; default is
# a fresh mktemp dir, printed at the end. UI_E2E_NO_BUILD=1 skips rebuilding
# app/server/public/v2 from app/ui/v2 (by default it rebuilds, so a change to
# the UI source is what gets tested; an unchanged tree rebuilds byte-identical).
# UI_E2E_DRIVER_BUDGET (seconds, default 600) bounds the browser driver.
#
# Order:
#   1. build the UI bundle (vite) into app/server/public/v2
#   2. demo/stack.sh's `demo_stack_up`: target19 + legacy15 datasets, dev
#      policy + token, server started through the writer gate on a free port
#   3. seed through the REAL CLI: peers, sessions, English + Thai messages,
#      and a secret session linked to the chat session that the asking peer
#      is NOT a member of (so chat coverage is partial, and the secret must
#      never reach the page)
#   4. drive the UI with `ego-browser nodejs` (ui-e2e/drive.mjs): create ->
#      revise -> cite -> correct -> retire a citer -> supersede -> evidence
#      labels -> history byte-identity -> peer chat -> Thai keyword search ->
#      a revision's label snapshot surviving a term rename and later edits
#   5. ALWAYS (trap on EXIT): clear the origin's storage and close the browser
#      space (ui-e2e/teardown.mjs), stop the server, remove the mktemp root
#
# Verdicts are `STEP_OK name`, `STEP_FAIL name: why`, `STEP_SKIP name (why)`.
# Any STEP_FAIL, a driver that does not reach E2E_DRIVER_DONE, or a non-zero
# driver exit makes this script exit 1. Chat needs local Ollama (gemma3:4b);
# with Ollama down it prints STEP_SKIP, never STEP_OK.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
SRV="$APP/server"
PY="$APP/migrate-py/.venv/bin/python"
SCRIPTS="$HERE/scripts"
DEMO_DIR="$HERE/demo"
E2E_DIR="$HERE/ui-e2e"

BANK="default"
CHAT_PEER="alice"
CHAT_SESSION="daily-loop"
SECRET_SESSION="secret-room"

# shellcheck source=/dev/null
source "$DEMO_DIR/lib.sh"
# shellcheck source=/dev/null
source "$DEMO_DIR/stack.sh"

OUT="${1:-}"
if [ -z "$OUT" ]; then OUT="$(mktemp -d "${TMPDIR:-/tmp}/arra-ui-e2e-out.XXXXXX")"; fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

echo "arra-oracle-v4 ui-e2e -- $(date -u +%Y-%m-%dT%H:%M:%SZ)  out: $OUT"
command -v ego-browser >/dev/null 2>&1 || { echo "STEP_FAIL preflight: ego-browser not on PATH (this test is local-only)"; exit 1; }
resolve_ollama

CFG=""
LEASE=""
# Browser teardown. teardown.mjs appends its own lines to teardown.txt as it
# goes (stdout from `ego-browser nodejs` only arrives at exit). It is
# idempotent -- clear one origin's storage, close one space -- so a second
# attempt after a 60s timeout is safe even if the first is still running
# inside the ego service. It counts only when it PROVES the origin clear
# (`after=0`) and the space finished; otherwise STEP_FAIL and exit 1: a
# leaked token in localStorage is a failure, not a footnote.
BROWSER_DOWN_FAILED=0
browser_down() {
  [ -n "$LEASE" ] && rm -f "$LEASE"
  [ -n "$CFG" ] && [ -f "$CFG" ] || return 0
  [ -f "$ROOT/ego-space-id" ] || { echo "TEARDOWN no browser space was opened"; return 0; }
  local attempt log="$OUT/teardown.txt"
  : >"$log"
  for attempt in 1 2; do
    timeout 60 ego-browser nodejs -e "const m = await import('$E2E_DIR/teardown.mjs'); await m.teardown('$CFG');" \
      >"$OUT/teardown-stdout.txt" 2>&1 </dev/null
    if rg -q '^TEARDOWN origin .* after=0$' "$log" && rg -q '^TEARDOWN space .* finished' "$log"; then
      rg '^TEARDOWN' "$log"
      return 0
    fi
    echo "RETRY browser-teardown attempt $attempt/2: $(tail -c 300 "$log" "$OUT/teardown-stdout.txt" | tr '\n' ' ')"
  done
  rg '^TEARDOWN' "$log"
  echo "STEP_FAIL browser-teardown: space $(cat "$ROOT/ego-space-id") not proven closed with origin storage after=0"
  BROWSER_DOWN_FAILED=1
}
cleanup() {
  local rc=$?
  # An interrupted run can leave the transcript's `tail -F` behind.
  local j; for j in $(jobs -p); do kill "$j" 2>/dev/null; done
  browser_down
  [ "$BROWSER_DOWN_FAILED" -eq 1 ] && rc=1
  demo_stack_down
  echo
  echo "UI_E2E_OUT $OUT"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step "build the v2 UI from app/ui/v2 into app/server/public/v2"
if [ "${UI_E2E_NO_BUILD:-0}" = "1" ]; then
  echo "STEP_SKIP ui-build (UI_E2E_NO_BUILD=1, testing the bundle already on disk)"
else
  (cd "$APP/ui/v2" && bun run build) >"$OUT/ui-build.log" 2>&1 || { tail -20 "$OUT/ui-build.log"; fail "ui-build" "vite build failed"; }
  if [ -n "$(git -C "$APP/.." status --porcelain -- app/server/public/v2)" ]; then
    echo "NOTE the rebuilt bundle differs from the committed one: this run tests the working-tree UI source"
  fi
  ok "ui-build"
fi

demo_stack_up
CLI=(bun "$APP/cli.ts")

# `message append` answers the stored row; its public_id is what chat cites.
public_id_of() {
  "$PY" -c "
import json, sys
def walk(v):
    if isinstance(v, dict):
        if isinstance(v.get('public_id'), str): return v['public_id']
        for x in v.values():
            r = walk(x)
            if r: return r
    if isinstance(v, list):
        for x in v:
            r = walk(x)
            if r: return r
    return None
print(walk(json.loads(sys.argv[1])) or '')
" "$1"
}

step "seed through the real CLI: 3 peers, 2 sessions, EN + Thai messages, a secret linked session"
REQ="$ROOT/req"; mkdir -p "$REQ"
for p in alice bob carol; do run_cli peer add --name "$p" >/dev/null || fail "seed" "peer add $p: $LAST_OUT"; done
for s in "$CHAT_SESSION" "$SECRET_SESSION"; do run_cli session add --name "$s" >/dev/null || fail "seed" "session add $s: $LAST_OUT"; done
join() {
  echo "{\"workspace_name\":\"$BANK\",\"session_name\":\"$1\",\"peer_name\":\"$2\"}" >"$REQ/join-$1-$2.json"
  run_cli kb joinSession --file "$REQ/join-$1-$2.json" >/dev/null || fail "seed" "joinSession $1 $2: $LAST_OUT"
}
join "$CHAT_SESSION" alice; join "$CHAT_SESSION" bob; join "$SECRET_SESSION" carol
VISIBLE_IDS=()
run_cli message append --session "$CHAT_SESSION" --peer alice --role user \
  --content "Don't forget: snapshot the disk before the migration rehearsal." >/dev/null || fail "seed" "$LAST_OUT"
VISIBLE_IDS+=("$(public_id_of "$LAST_OUT")")
run_cli message append --session "$CHAT_SESSION" --peer bob --role assistant \
  --content "อย่าหลงลืมนะ ต้อง snapshot ดิสก์ก่อนซ้อมย้ายข้อมูลทุกครั้ง" >/dev/null || fail "seed" "$LAST_OUT"
VISIBLE_IDS+=("$(public_id_of "$LAST_OUT")")
CANARY="SECRET-CANARY-$(nid)"
run_cli message append --session "$SECRET_SESSION" --peer carol --role user \
  --content "$CANARY: the vault passphrase is only for carol." >/dev/null || fail "seed" "$LAST_OUT"
"$PY" -c "import json,sys;print(json.dumps({'id':sys.argv[1],'workspace_name':sys.argv[2],'from_session_name':sys.argv[3],'to_session_name':sys.argv[4],'relation':'related_to','evidence_ref':None,'created_by_peer_name':'alice'}))" \
  "$(nid)" "$BANK" "$CHAT_SESSION" "$SECRET_SESSION" >"$REQ/link.json"
run_cli kb createSessionLink --file "$REQ/link.json" >/dev/null || fail "seed" "createSessionLink: $LAST_OUT"
for id in "${VISIBLE_IDS[@]}"; do [ -n "$id" ] || fail "seed" "a seeded message came back without a public_id"; done
echo "visible message ids: ${VISIBLE_IDS[*]}   secret session: $SECRET_SESSION (alice is not a member)"
ok "seed"

CFG="$ROOT/ui-e2e-config.json"
LEASE="$ROOT/driver-lease"
BUDGET="${UI_E2E_DRIVER_BUDGET:-600}"
"$PY" - "$CFG" "$ORIGIN" "$PORT" "$TOKEN" "$OUT" "$ROOT/ego-space-id" "$OLLAMA_UP" "$OLLAMA_BASE" \
  "$CHAT_PEER" "$CHAT_SESSION" "$CANARY" "$LEASE" "$BUDGET" "${VISIBLE_IDS[@]}" <<'PY'
import json, sys, time
(cfg, origin, port, token, out, space, up, base, peer, session, canary, lease, budget), ids = sys.argv[1:14], sys.argv[14:]
json.dump({"origin": origin, "port": port, "token": token, "outDir": out, "spaceFile": space,
           "ollamaUp": up == "1", "ollamaBase": base, "peer": peer, "session": session,
           "canary": canary, "visibleMessageIds": ids,
           "transcript": out + "/transcript.txt", "teardownLog": out + "/teardown.txt",
           "lease": lease, "deadline": int(time.time() * 1000) + int(budget) * 1000}, open(cfg, "w"))
PY

# One driver attempt, never a retry. Measured on ego-browser 0.5.1.13:
# `ego-browser nodejs` hands the script's stdout back only when the script
# exits (0 bytes at t=5s of an 8s script, file or pipe alike), and killing
# that client does not stop the script, which keeps running inside the ego
# service. So a watchdog on stdout cannot see progress, and a restart would
# drive the same server twice and could replace a slow run's STEP_FAILs with
# a later attempt's STEP_OKs. Instead:
#   - the driver appends every line to transcript.txt itself; `tail -F`
#     streams it live, and the verdict is counted from it;
#   - it stops itself at the config's deadline (BUDGET seconds from now):
#     every step still running or not yet started is a STEP_FAIL;
#   - `timeout` (BUDGET + 60s) is only a backstop for a call stuck inside
#     the ego SDK. When it fires, or when the driver exits, the lease file is
#     removed: from then on the driver writes nothing and aborts, and the
#     verdict is read from a copy (verdict.txt) taken at that moment.
run_driver() {
  local tailpid
  : >"$OUT/transcript.txt"
  : >"$LEASE"
  tail -n +1 -F "$OUT/transcript.txt" 2>/dev/null &
  tailpid=$!
  timeout "$((BUDGET + 60))" ego-browser nodejs -e "const m = await import('$E2E_DIR/drive.mjs'); await m.drive('$CFG');" \
    >"$OUT/driver-stdout.txt" 2>&1 </dev/null
  DRIVER_RC=$?
  rm -f "$LEASE"
  sleep 0.5
  kill "$tailpid" 2>/dev/null
  wait "$tailpid" 2>/dev/null
  cp "$OUT/transcript.txt" "$OUT/verdict.txt"
  if [ "$DRIVER_RC" -eq 124 ]; then
    echo "STEP_FAIL driver-timeout: no exit within $((BUDGET + 60))s (budget ${BUDGET}s)" | tee -a "$OUT/verdict.txt"
  fi
  if [ "$DRIVER_RC" -ne 0 ]; then
    echo "driver exited rc=$DRIVER_RC; the last of its stdout/stderr:"
    tail -n 15 "$OUT/driver-stdout.txt"
  fi
}

step "drive the built UI with ego-browser (ui-e2e/drive.mjs)"
DRIVER_RC=1
run_driver

N_OK=$(rg -c '^STEP_OK ' "$OUT/verdict.txt" || true)
N_FAIL=$(rg -c '^STEP_FAIL ' "$OUT/verdict.txt" || true)
N_SKIP=$(rg -c '^STEP_SKIP ' "$OUT/verdict.txt" || true)
echo
if [ "$DRIVER_RC" -ne 0 ] || ! rg -q '^E2E_DRIVER_DONE$' "$OUT/verdict.txt" || [ "${N_FAIL:-0}" -gt 0 ]; then
  echo "UI_E2E_RESULT FAIL ok=${N_OK:-0} fail=${N_FAIL:-0} skip=${N_SKIP:-0} driver_rc=$DRIVER_RC"
  exit 1
fi
echo "UI_E2E_RESULT PASS ok=${N_OK:-0} fail=0 skip=${N_SKIP:-0}"
