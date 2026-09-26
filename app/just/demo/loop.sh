# The knowledge-tier daily loop, driven ONLY through the real CLI
# (`bun app/cli.ts` -- friendly aliases and the generic `kb <method>`, #31 R8).
# Sourced by demo.sh, which has already run `demo_stack_up` (so ARRA_URL/
# ARRA_BANK/ARRA_TOKEN are exported) and set BANK/PEER_ALICE/PEER_BOB/SESSION.
#
# Every request body this loop cannot build as flat JSON (`publishRevision`'s
# envelope nests a JSON-STRING column, `term_snapshot_json`) goes through a
# tiny python heredoc instead of hand-escaped bash -- the same "python3 for
# structure" idiom `app/just/scripts/*.py` already uses, not a new one.

# Build one `publishRevision` request file: `{operation_id, content}`, with
# `content` shaped exactly like `test/helpers/publication-fixture.ts`'s own
# `revisionEnvelope()` (the 21 ENVELOPE_KEYS, `contracts/revision-v1.ts`).
build_publish_request() {
  local file="$1" node_id="$2" base_revision_id="$3" title="$4" body="$5" \
    term_id="$6" vocabulary_id="$7" vocabulary_name="$8" term_name="$9" \
    author_peer="${10}" session_name="${11}" operation_id="${12}"
  "$PY" - "$file" "$node_id" "$base_revision_id" "$title" "$body" "$term_id" \
    "$vocabulary_id" "$vocabulary_name" "$term_name" "$author_peer" "$session_name" \
    "$operation_id" "$BANK" <<'PY'
import json, sys
(file, node_id, base_revision_id, title, body, term_id, vocabulary_id,
 vocabulary_name, term_name, author_peer, session_name, operation_id, bank) = sys.argv[1:14]
content = {
    "workspace_name": bank, "node_id": node_id,
    "base_revision_id": base_revision_id or None,
    "title": title, "body": body, "body_format": "markdown", "fields": "{}",
    "author_peer_name": author_peer, "observer_peer_name": None, "subject_peer_name": None,
    "session_name": session_name, "is_active": True, "valid_from": None, "valid_to": None,
    "change_reason": None, "schema_version": "1", "canonical_version": "arra-revision/v1",
    "term_snapshot_json": json.dumps([{
        "term_id": term_id, "vocabulary_id": vocabulary_id,
        "vocabulary_name_snapshot": vocabulary_name, "term_name_snapshot": term_name,
        "label_snapshot": None, "position": "0",
    }]),
    "link_snapshot_json": "[]", "h_metadata": None, "internal_metadata": None,
}
with open(file, "w", encoding="utf-8") as f:
    json.dump({"operation_id": operation_id, "content": content}, f, ensure_ascii=False)
PY
}

demo_kb_loop() {
  local req="$ROOT/req"
  mkdir -p "$req"

  step "register 2 peers"
  run_cli peer add --name "$PEER_ALICE" || fail "register-peers" "$LAST_OUT"
  run_cli peer add --name "$PEER_BOB" || fail "register-peers" "$LAST_OUT"
  ok "register-peers"

  step "open a session and join both peers"
  run_cli session add --name "$SESSION" || fail "open-session" "$LAST_OUT"
  cat >"$req/join-alice.json" <<JSON
{"workspace_name":"$BANK","session_name":"$SESSION","peer_name":"$PEER_ALICE"}
JSON
  run_cli kb joinSession --file "$req/join-alice.json" || fail "open-session" "$LAST_OUT"
  cat >"$req/join-bob.json" <<JSON
{"workspace_name":"$BANK","session_name":"$SESSION","peer_name":"$PEER_BOB"}
JSON
  run_cli kb joinSession --file "$req/join-bob.json" || fail "open-session" "$LAST_OUT"
  ok "open-session"

  step "append an English message and a Thai message"
  run_cli message append --session "$SESSION" --peer "$PEER_ALICE" --role user \
    --content "Don't forget: snapshot the disk before the migration rehearsal." \
    || fail "append-messages" "$LAST_OUT"
  run_cli message append --session "$SESSION" --peer "$PEER_BOB" --role assistant \
    --content "อย่าหลงลืมนะ ต้อง snapshot ดิสก์ก่อนซ้อมย้ายข้อมูลทุกครั้ง" \
    || fail "append-messages" "$LAST_OUT"
  ok "append-messages"

  step "seed the reserved 'type' vocabulary (R10: conclusion is a type term, not a table)"
  TYPE_VOCAB_ID="$(nid)"; HORIZON_VOCAB_ID="$(nid)"
  TERM_NOTE_ID="$(nid)"; TERM_CONCLUSION_ID="$(nid)"; TERM_LEARNING_ID="$(nid)"
  TERM_DISCUSSION_ID="$(nid)"; TERM_CORRECTION_ID="$(nid)"
  TERM_SHORT_ID="$(nid)"; TERM_LONG_ID="$(nid)"
  cat >"$req/seed.json" <<JSON
{"workspace_name":"$BANK",
 "type":{"vocabulary_id":"$TYPE_VOCAB_ID","terms":{
   "note":"$TERM_NOTE_ID","conclusion":"$TERM_CONCLUSION_ID","learning":"$TERM_LEARNING_ID",
   "discussion":"$TERM_DISCUSSION_ID","correction":"$TERM_CORRECTION_ID"}},
 "memory_horizon":{"vocabulary_id":"$HORIZON_VOCAB_ID","terms":{
   "short_term":"$TERM_SHORT_ID","long_term":"$TERM_LONG_ID"}}}
JSON
  run_cli kb seedReservedVocabularies --file "$req/seed.json" || fail "seed-vocab" "$LAST_OUT"
  ok "seed-vocab"

  step "look the reserved 'learning' type term up BY NAME (K2), the way a caller with no minted ids would"
  echo "{\"workspace_name\":\"$BANK\",\"name\":\"type\"}" >"$req/lookup-vocab.json"
  run_cli kb lookupVocabularyByName --file "$req/lookup-vocab.json" || fail "lookup-type-term" "$LAST_OUT"
  local vocab_id; vocab_id="$(jget "$LAST_OUT" id)"
  "$PY" -c "import json,sys;print(json.dumps({'workspace_name':sys.argv[1],'vocabulary_id':sys.argv[2],'name':'learning'}))" \
    "$BANK" "$vocab_id" >"$req/lookup-term.json"
  run_cli kb lookupTermByName --file "$req/lookup-term.json" || fail "lookup-type-term" "$LAST_OUT"
  local term_id; term_id="$(jget "$LAST_OUT" id)"
  ok "lookup-type-term"

  step "publish a knowledge node, type=learning, Thai body containing หลงลืม"
  NODE1_ID="$(nid)"
  build_publish_request "$req/publish-1.json" "$NODE1_ID" "" \
    "ผ่าดิสก์: อย่าหลงลืม snapshot ก่อนซ้อมย้ายข้อมูล" \
    "หลงลืมการ snapshot ดิสก์ก่อนผ่าตัด (repartition/migrate) ทำให้กู้คืนย้อนกลับไม่ได้ -- ทุกครั้งต้อง tmutil localsnapshot ก่อนเสมอ" \
    "$term_id" "$vocab_id" "type" "learning" "$PEER_ALICE" "$SESSION" "demo-publish-node1"
  run_cli kb publishRevision --file "$req/publish-1.json" || fail "publish-node" "$LAST_OUT"
  looks_like_error "$LAST_OUT" && fail "publish-node" "$LAST_OUT"
  NODE1_REVISION_ID="$(jget "$LAST_OUT" revision_id)"
  ok "publish-node"

  step "index its chunks (search is a separate step from publish -- #30, 'index first')"
  EMBEDDING_MODEL_NAME="${EMBEDDING_MODEL:-all-minilm}"
  PROFILE_NAME="ollama/${EMBEDDING_MODEL_NAME}/384/none"
  cat >"$req/index-1.json" <<JSON
{"workspace_name":"$BANK","node_id":"$NODE1_ID","revision_id":"$NODE1_REVISION_ID",
 "chunker_version":"chunker/v1","embedding_profile":{"name":"$PROFILE_NAME","dims":384}}
JSON
  run_cli kb indexRevisionChunks --file "$req/index-1.json" || fail "index-chunks" "$LAST_OUT"
  ok "index-chunks"

  if [ "$OLLAMA_UP" -eq 1 ]; then
    step "embed pending chunks with the real local Ollama, $EMBEDDING_MODEL_NAME"
    echo "{\"workspace_name\":\"$BANK\",\"limit\":10}" >"$req/embed.json"
    run_cli kb embedPendingChunks --file "$req/embed.json" || fail "embed-chunks" "$LAST_OUT"
    # Fix round (blocking finding 1): a call that answers `blocked` or writes
    # nothing must not read as success just because the CLI exited 0 -- R20's
    # whole point is that an unmeasurable/mismatched digest embeds NOTHING.
    echo "$LAST_OUT" | "$PY" -c "
import json, sys
d = json.load(sys.stdin)
assert d.get('blocked') is None, f\"embed blocked, nothing written: {d!r}\"
assert d.get('failed', 0) == 0, f\"embed reported failures: {d!r}\"
assert (d.get('embedded', 0) + d.get('reused', 0)) >= 1, f\"embed wrote no vector: {d!r}\"
" || fail "embed-chunks" "embed result did not actually embed or reuse a vector"
    ok "embed-chunks"
  else
    skip "embed-chunks" "Ollama unreachable at $OLLAMA_BASE"
  fi

  step "getSearchFreshness (R20: show the pinned model digest)"
  echo "{\"workspace_name\":\"$BANK\"}" >"$req/freshness.json"
  run_cli kb getSearchFreshness --file "$req/freshness.json" || fail "search-freshness" "$LAST_OUT"
  if [ "$OLLAMA_UP" -eq 1 ]; then
    # Fix round: R20's claim ("pinned == last_measured" right after a real
    # embed) was previously read off the transcript by eye. Assert it.
    echo "$LAST_OUT" | "$PY" -c "
import json, sys
d = json.load(sys.stdin)
v = d.get('vectors', {})
digest = v.get('model_digest', {})
assert v.get('ready', 0) >= 1, f\"R20: no ready vectors after a real embed: {v!r}\"
assert digest.get('pinned') is not None, f\"R20: no pinned digest after a real embed: {digest!r}\"
assert digest.get('pinned') == digest.get('last_measured'), f\"R20: pinned != last_measured: {digest!r}\"
" || fail "search-freshness" "R20 digest not pinned/measured consistently after a real embed"
  fi
  ok "search-freshness"

  step "keyword search 'ลืม' -- Thai INSIDE a word (R14: ngram(3,3), not ICU)"
  run_cli search --mode keyword --query "ลืม" --limit 5 || fail "keyword-search" "$LAST_OUT"
  echo "$LAST_OUT" | "$PY" -c "
import json, sys
hits = json.load(sys.stdin).get('hits', [])
assert any('$NODE1_ID' == r.get('node_id') for r in hits), 'keyword search did not find the published node'
" || fail "keyword-search" "expected node $NODE1_ID in the hits"
  ok "keyword-search"

  if [ "$OLLAMA_UP" -eq 1 ]; then
    step "semantic search over the same chunks"
    run_cli search --mode semantic --query "forgetting to snapshot the disk before a migration" --limit 5 \
      || fail "semantic-search" "$LAST_OUT"
    # Fix round: same "did it actually find the node" check keyword-search
    # already makes -- an empty `hits` array with exit 0 must not read OK.
    echo "$LAST_OUT" | "$PY" -c "
import json, sys
hits = json.load(sys.stdin).get('hits', [])
assert any('$NODE1_ID' == r.get('node_id') for r in hits), 'semantic search did not find the published node'
" || fail "semantic-search" "expected node $NODE1_ID in the semantic hits"
    ok "semantic-search"
  else
    skip "semantic-search" "Ollama unreachable at $OLLAMA_BASE"
  fi

  step "getContext for alice in $SESSION"
  run_cli context get --peer "$PEER_ALICE" --session "$SESSION" --max-items 10 \
    || fail "get-context" "$LAST_OUT"
  ok "get-context"

  if [ "$OLLAMA_UP" -eq 1 ]; then
    step "chat ask, real local Ollama gemma3:4b (citations + coverage)"
    run_cli chat ask --peer "$PEER_ALICE" --session "$SESSION" --max-items 10 \
      --question "What should I remember to do before a disk migration?" \
      || fail "chat-ask" "$LAST_OUT"
    echo "$LAST_OUT" | "$PY" -c "
import json, sys
d = json.load(sys.stdin)
assert isinstance(d.get('answer'), str) and d['answer'].strip(), 'no answer text'
assert isinstance(d.get('items_used'), list), 'no items_used (citations)'
assert 'coverage' in d, 'no coverage field'
print(f\"answer: {d['answer']!r}\")
print(f\"citations (items_used): {d['items_used']}\")
print(f\"coverage: {d['coverage']}\")
" || fail "chat-ask" "answer missing citations/coverage"
    ok "chat-ask"
  else
    skip "chat-ask" "Ollama unreachable at $OLLAMA_BASE"
  fi

  step "supersede node1 with a corrected revision (new node, R7 #29 lifecycle)"
  NODE2_ID="$(nid)"
  build_publish_request "$req/publish-2.json" "$NODE2_ID" "" \
    "ผ่าดิสก์: อย่าหลงลืม snapshot ก่อนซ้อมย้ายข้อมูล (แก้ไข)" \
    "แก้ไข: หลงลืมการ snapshot ดิสก์ก่อนผ่าตัด (repartition/migrate) ทำให้กู้คืนไม่ได้ -- ใช้ tmutil localsnapshot เสมอ อ้างอิง APFS snapshot rollback" \
    "$term_id" "$vocab_id" "type" "learning" "$PEER_ALICE" "$SESSION" "demo-publish-node2"
  run_cli kb publishRevision --file "$req/publish-2.json" || fail "supersede-node" "$LAST_OUT"
  NODE2_REVISION_ID="$(jget "$LAST_OUT" revision_id)"
  cat >"$req/supersede.json" <<JSON
{"workspace_name":"$BANK","node_id":"$NODE1_ID","expected_revision_id":"$NODE1_REVISION_ID",
 "new_node_id":"$NODE2_ID","new_revision_id":"$NODE2_REVISION_ID",
 "reason":"corrected the Thai wording after review","peer_name":"$PEER_ALICE",
 "operation_id":"demo-supersede-node1"}
JSON
  run_cli kb supersedeNode --file "$req/supersede.json" || fail "supersede-node" "$LAST_OUT"
  ok "supersede-node"

  step "nodes list (default) -- excludes the superseded node"
  run_cli nodes list --limit 20 || fail "nodes-list-default" "$LAST_OUT"
  echo "$LAST_OUT" | "$PY" -c "
import json, sys
ids = {r.get('id') for r in json.load(sys.stdin).get('rows', [])}
assert '$NODE1_ID' not in ids, 'superseded node1 still in the default listing'
assert '$NODE2_ID' in ids, 'corrected node2 missing from the default listing'
" || fail "nodes-list-default" "unexpected membership"
  ok "nodes-list-default"

  step "nodes list --history -- includes both the superseded node and its successor"
  run_cli nodes list --limit 20 --history || fail "nodes-list-history" "$LAST_OUT"
  echo "$LAST_OUT" | "$PY" -c "
import json, sys
ids = {r.get('id') for r in json.load(sys.stdin).get('rows', [])}
assert '$NODE1_ID' in ids, 'superseded node1 missing from --history'
assert '$NODE2_ID' in ids, 'corrected node2 missing from --history'
" || fail "nodes-list-history" "unexpected membership"
  ok "nodes-list-history"
}
