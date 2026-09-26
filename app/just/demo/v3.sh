# The v3-compatible MCP adapter loop (#31 legacy adapters, V3-PARITY.md,
# DECISIONS.md R18), driven ONLY over the real MCP endpoint -- raw JSON-RPC
# via curl, not the CLI (the CLI has no v3 tool support and does not need
# any: this is here to prove the WIRE contract an existing v3 MCP client
# would actually speak). The server was started with `ARRA_MCP_V3_COMPAT=1`
# (stack.sh), so `oracle_*` tools are advertised and dispatchable.
#
# Sourced by demo.sh, which has run `demo_stack_up` and set ORIGIN/BANK/TOKEN.

RPC_ID=0

# One `tools/call`. `$3` is a JSON object literal (already valid JSON --
# built inline by callers, all of it caller-controlled ASCII/Thai text with
# no embedded quotes, so no python round trip is needed here the way
# `loop.sh`'s nested JSON-STRING column does). Leaves the response body in
# $LAST_OUT and its HTTP status in $LAST_STATUS.
mcp_v3_call() {
  local tool="$1" peer="$2" args_json="$3"
  RPC_ID=$((RPC_ID + 1))
  local body; body="$("$PY" -c "
import json, sys
print(json.dumps({'jsonrpc': '2.0', 'id': int(sys.argv[1]), 'method': 'tools/call',
                   'params': {'name': sys.argv[2], 'arguments': json.loads(sys.argv[3])}}))
" "$RPC_ID" "$tool" "$args_json")"
  local peer_args=()
  [ -n "$peer" ] && peer_args=(-H "x-arra-peer: $peer")
  show "curl -sS -X POST $ORIGIN/mcp/$BANK -H 'authorization: Bearer ***'${peer:+ -H \"x-arra-peer: $peer\"} -d '$args_json'   # tools/call $tool"
  # Fix round (blocking finding 2): under `set -u`, expanding an EMPTY array
  # with plain `"${peer_args[@]}"` is unbound-variable on bash < 4.4 (macOS
  # system /bin/bash is 3.2.57) -- `${arr[@]+"${arr[@]}"}` expands to nothing
  # when the array is empty/unset instead of erroring, on every bash version.
  local raw; raw="$(curl -sS -w $'\n%{http_code}' -X POST "$ORIGIN/mcp/$BANK" \
    -H "content-type: application/json" -H "authorization: Bearer $TOKEN" \
    ${peer_args[@]+"${peer_args[@]}"} \
    -d "$body")"
  LAST_STATUS="${raw##*$'\n'}"
  LAST_OUT="${raw%$'\n'*}"
  print_json "$LAST_OUT"
  echo
}

# True (exit 0) when the last `mcp_v3_call` answered `result.isError: true`.
mcp_v3_is_error() {
  "$PY" -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(d.get('result'), dict) and d['result'].get('isError') is True else 1)
" "$1"
}

# The first text block of a `tools/call` result, JSON-decoded (every
# `oracle_*` tool answers one JSON-encoded text block, per
# `session-child.ts`'s own `valueOf`).
mcp_v3_value() {
  "$PY" -c "
import json, sys
d = json.loads(sys.argv[1])
text = d['result']['content'][0]['text']
print(text)
" "$1"
}

demo_v3_loop() {
  step "v3 adapter: tools/list shows oracle_* tools (ARRA_MCP_V3_COMPAT=1)"
  local body; body="$("$PY" -c "print(__import__('json').dumps({'jsonrpc':'2.0','id':0,'method':'tools/list','params':{}}))")"
  show "curl -sS -X POST $ORIGIN/mcp/$BANK -H 'authorization: Bearer ***' -d '{\"method\":\"tools/list\",...}'"
  local raw; raw="$(curl -sS -w $'\n%{http_code}' -X POST "$ORIGIN/mcp/$BANK" \
    -H "content-type: application/json" -H "authorization: Bearer $TOKEN" -d "$body")"
  LAST_STATUS="${raw##*$'\n'}"; LAST_OUT="${raw%$'\n'*}"
  local names; names="$("$PY" -c "
import json, sys
tools = json.loads(sys.argv[1])['result']['tools']
oracle = sorted(t['name'] for t in tools if t['name'].startswith('oracle_'))
print(f'{len(tools)} tools total, {len(oracle)} oracle_*: {\", \".join(oracle)}')
" "$LAST_OUT")"
  echo "$names"
  echo "$names" | grep -q 'oracle_search' || fail "v3-tools-list" "oracle_* tools not advertised"
  ok "v3-tools-list"

  step "oracle_learn: publish a v3-shaped learning node"
  mcp_v3_call oracle_learn "$PEER_ALICE" \
    '{"pattern":"arra-oracle-v4 overnight demo: the end-to-end loop finally runs, CLI and MCP both.","concepts":["demo","arra-v4"],"project":"github.com/Soul-Brews-Studio/arra-oracle-v4"}'
  mcp_v3_is_error "$LAST_OUT" && fail "v3-oracle-learn" "$LAST_OUT"
  local learned; learned="$(mcp_v3_value "$LAST_OUT")"
  echo "$learned" | "$PY" -c "
import json, sys
d = json.load(sys.stdin)
assert d.get('success') is True, 'oracle_learn did not report success'
assert d.get('embedding') in ('enqueued', 'skipped', None) or isinstance(d.get('embedding'), str), 'unexpected embedding field'
print(f\"learned node: {d['id']}\")
" || fail "v3-oracle-learn" "unexpected oracle_learn shape"
  ok "v3-oracle-learn"

  step "oracle_search: finds what oracle_learn just published"
  mcp_v3_call oracle_search "" '{"query":"arra-oracle-v4 overnight demo end-to-end loop","limit":5}'
  mcp_v3_is_error "$LAST_OUT" && fail "v3-oracle-search" "$LAST_OUT"
  local learned_id; learned_id="$(jget "$learned" id)"
  mcp_v3_value "$LAST_OUT" | "$PY" -c "
import json, sys
d = json.load(sys.stdin)
ids = [r.get('id') for r in d.get('results', [])]
assert '$learned_id' in ids, f'oracle_search did not return {\"$learned_id\"!r} among {ids!r}'
" || fail "v3-oracle-search" "did not find the just-learned node"
  ok "v3-oracle-search"

  step "oracle_thread: post as $PEER_ALICE (speaker via X-Arra-Peer)"
  mcp_v3_call oracle_thread "$PEER_ALICE" \
    '{"title":"demo: overnight loop chat","message":"[demo] posted through the v3 forum adapter over real MCP."}'
  mcp_v3_is_error "$LAST_OUT" && fail "v3-oracle-thread" "$LAST_OUT"
  local thread_value; thread_value="$(mcp_v3_value "$LAST_OUT")"
  THREAD_ID="$("$PY" -c "import json,sys;print(json.loads(sys.argv[1])['thread_id'])" "$thread_value")"
  ok "v3-oracle-thread"

  step "oracle_thread_read: read it back as $PEER_ALICE"
  mcp_v3_call oracle_thread_read "$PEER_ALICE" "{\"threadId\":\"$THREAD_ID\"}"
  mcp_v3_is_error "$LAST_OUT" && fail "v3-oracle-thread-read" "$LAST_OUT"
  mcp_v3_value "$LAST_OUT" | "$PY" -c "
import json, sys
d = json.load(sys.stdin)
assert d.get('message_count') == 1, f\"expected 1 message, got {d.get('message_count')!r}\"
assert 'posted through the v3 forum adapter' in d['messages'][0]['content']
" || fail "v3-oracle-thread-read" "unexpected thread contents"
  ok "v3-oracle-thread-read"
}
