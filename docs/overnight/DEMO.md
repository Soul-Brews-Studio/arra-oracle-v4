# DEMO -- arra-oracle-v4 end to end, for real

**Version**: `v26.9.27-alpha.319`
**Date**: 2026-09-27, Asia/Bangkok
**What this is**: a captured, VERBATIM transcript of one real run of
`app/just/demo.sh` on m5, with a real local Ollama serving `all-minilm` and
`gemma3:4b`. Nothing here is edited except the auth token, which the
transcript itself never prints (`app/cli.ts`'s own rule: no flag, no config
file, never logged) -- there is nothing to redact.

This is the demo Nat asked for and never got (relic `c30e0ba2` #20246,
2026-09-21): *"make all finished today! but today done implement embeded FULL
TEST CLI FIRST LET PLAY LET MEMORY INDEX LANCEDB"*. One command:

```sh
bash app/just/demo.sh
```

```text
  mktemp stack                    real transports                 always
  ------------------              ------------------               ------
  target19 dataset      -->       bun app/cli.ts (kb + aliases)     stop server
  legacy15 dataset      -->       curl JSON-RPC /mcp/:bank          rm -rf stack
  dev policy + token    -->       (ARRA_MCP_V3_COMPAT=1)
```

Run this way: `bash app/just/demo.sh > transcript.log 2>&1` on a machine with
Ollama already serving `all-minilm` and `gemma3:4b` (`ollama pull` both
first if not). If Ollama is unreachable, the model-dependent steps
(embedding, semantic search, chat) print an explicit `STEP_SKIPPED ...` line
instead of faking output -- see `app/just/demo.test.ts`, which proves that
path too, with a stub.

Every section below is the SAME transcript, split only at this script's own
`== N. ... ==` step markers so a short note can sit beside each one. The
fenced blocks are byte-for-byte what the terminal printed.

## Startup banner

Printed before any step: today's UTC timestamp and whether a real Ollama answered the reachability probe.

```text
arra-oracle-v4 demo -- 2026-09-26T20:14:43Z
Ollama reachable at http://127.0.0.1:11434 -- embed/semantic-search/chat run for real.
```

## Step 1. fresh mktemp stack: target19 + legacy15 + dev policy
One mktemp root holds two datasets: target19 (the knowledge tier) and legacy15 (memories/mcp_calls/connections). Never app/.tmp, never app/data.
```text
== 1. fresh mktemp stack: target19 + legacy15 + dev policy ==
+ mktemp -d  ->  /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV
+ ARRA_DATA_DIR=/var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy /opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-demo-27sep-sun2026/app/migrate-py/.venv/bin/python -m arra_migrate
/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-demo-27sep-sun2026/app/migrate-py/src/arra_migrate/__main__.py:34: DeprecationWarning: table_names() is deprecated, use list_tables() instead
  existing = set(db.table_names(limit=1000))
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/workspaces.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/peers.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/sessions.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/session_peers.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/messages.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/memories.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/vocabularies.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/terms.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/memory_terms.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/supersede_log.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/traces.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/trace_hits.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/mcp_calls.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/connections.lance, it will be created
[2026-09-26T20:14:44Z WARN  lance::dataset::write::insert] No existing dataset at /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T/arra-demo.Tm4DFV/legacy/read_cursors.lance, it will be created
store: /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy (local)
created workspaces @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/workspaces.lance
  id                   string
  name                 string
  created_at           timestamp[us]
  h_metadata           string  null
  internal_metadata    string  null
  configuration        string  null
  mission              string  null
created peers @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/peers.lance
  id                   string
  name                 string
  workspace_name       string
  h_metadata           string  null
  internal_metadata    string  null
  configuration        string  null
  created_at           timestamp[us]
created sessions @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/sessions.lance
  id                   string
  name                 string
  workspace_name       string
  is_active            bool
  h_metadata           string  null
  internal_metadata    string  null
  configuration        string  null
  created_at           timestamp[us]
created session_peers @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/session_peers.lance
  workspace_name       string
  session_name         string
  peer_name            string
  configuration        string  null
  internal_metadata    string  null
  joined_at            timestamp[us]
  left_at              timestamp[us]  null
created messages @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/messages.lance
  id                   int64
  public_id            string
  workspace_name       string
  session_name         string
  peer_name            string
  content              string
  token_count          int64
  seq_in_session       int64
  h_metadata           string  null
  internal_metadata    string  null
  created_at           timestamp[us]
  role                 string  null
  in_reply_to          string  null
  read                 bool  null
  read_at              timestamp[us]  null
created memories @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/memories.lance
  id                   string
  name                 string
  workspace_name       string
  session_name         string  null
  peer_name            string  null
  subject_peer_name    string  null
  type                 string
  content              string
  embedding            fixed_size_list<item: float>[384]  null
  created_at           timestamp[us]
  valid_from           timestamp[us]  null
  valid_to             timestamp[us]  null
  sync_state           string
  last_sync_at         timestamp[us]  null
  sync_attempts        int64
  superseded_by        string  null
  superseded_at        timestamp[us]  null
  is_active            bool
  h_metadata           string  null
  internal_metadata    string  null
created vocabularies @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/vocabularies.lance
  id                   string
  name                 string
  workspace_name       string
  label                string
  description          string  null
  kind                 string
  term_policy          string
  h_metadata           string  null
  internal_metadata    string  null
  created_at           timestamp[us]
created terms @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/terms.lance
  id                   string
  vocabulary_id        string
  name                 string
  description          string  null
  parent_id            string  null
  weight               double
  h_metadata           string  null
  created_at           timestamp[us]
created memory_terms @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/memory_terms.lance
  memory_id            string
  term_id              string
created supersede_log @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/supersede_log.lance
  id                   int64
  workspace_name       string
  old_id               string
  old_title            string  null
  old_type             string  null
  old_source           string  null
  new_id               string  null
  new_title            string  null
  new_source           string  null
  reason               string  null
  peer_name            string  null
  superseded_at        timestamp[us]
  h_metadata           string  null
created traces @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/traces.lance
  id                   string
  name                 string
  workspace_name       string
  session_name         string  null
  peer_name            string  null
  query                string
  mode                 string  null
  session_id           string  null
  session_from_ts      int64  null
  session_to_ts        int64  null
  friction_score       double  null
  confidence           string  null
  parent_id            string  null
  prev_id              string  null
  depth                int64
  status               string
  distilled_to         string  null
  distilled_at         int64  null
  h_metadata           string  null
  internal_metadata    string  null
  created_at           int64
  updated_at           int64
created trace_hits @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/trace_hits.lance
  trace_id             string
  kind                 string
  ref                  string
  line_start           int64  null
  line_end             int64  null
  note                 string  null
  position             int64
created mcp_calls @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/mcp_calls.lance
  id                   string
  workspace_name       string
  session_name         string  null
  peer_name            string  null
  tool                 string
  status               string
  duration_ms          int64
  h_metadata           string  null
  internal_metadata    string  null
  created_at           int64
created connections @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/connections.lance
  id                   string
  workspace_name       string
  method               string
  principal            string
  label                string
  user_agent           string  null
  remote_ip            string  null
  first_seen           timestamp[us]
  last_seen            timestamp[us]
  requests             int64
  tool_calls           int64
  last_tool            string  null
created read_cursors @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/legacy/read_cursors.lance
  peer_name            string
  session_name         string
  last_read_message_id string  null
  last_read_at         timestamp[us]

+ /opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-demo-27sep-sun2026/app/migrate-py/.venv/bin/python app/just/scripts/create_target19_dataset.py /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset
/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-demo-27sep-sun2026/app/just/scripts/create_target19_dataset.py:60: DeprecationWarning: table_names() is deprecated, use list_tables() instead
  existing = set(db.table_names(limit=1000))
created workspaces @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/workspaces.lance
created peers @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/peers.lance
created sessions @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/sessions.lance
created session_peers @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/session_peers.lance
created messages @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/messages.lance
created session_links @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/session_links.lance
created nodes @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/nodes.lance
created node_revisions @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/node_revisions.lance
created node_revision_terms @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/node_revision_terms.lance
created revision_links @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/revision_links.lance
created supersede_log @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/supersede_log.lance
created vocabularies @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/vocabularies.lance
created terms @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/terms.lance
created traces @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/traces.lance
created trace_hits @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/trace_hits.lance
created search_chunks_v1 @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/search_chunks_v1.lance
created mcp_calls @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/mcp_calls.lance
created connections @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/connections.lance
created read_cursors @ /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset/read_cursors.lance
seeded  workspaces row 'default'

STEP_OK dataset-create
+ /opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-demo-27sep-sun2026/app/migrate-py/.venv/bin/python app/just/scripts/write_dev_policy.py /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV default demo-operator
policy: /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dev-policy.json
token:  (never printed -- see app/cli.ts's own rule)
STEP_OK dev-policy
```

## Step 2. start the server through the writer gate on a free port (57271)
run_dev_server.py execs into `bun run src/index.ts`, holding fd 42 (the writer-gate flock) for the process's whole life. ARRA_MCP_V3_COMPAT=1 turns on the oracle_* tools used from step 19.
```text
== 2. start the server through the writer gate on a free port (57271) ==
+ ARRA_AUTH_POLICY=... ARRA_ORIGIN=http://127.0.0.1:57271 PORT=57271 ARRA_KNOWLEDGE_DATASET_ROOT=/var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset ARRA_MCP_V3_COMPAT=1 \
+   /opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-demo-27sep-sun2026/app/migrate-py/.venv/bin/python app/just/scripts/run_dev_server.py /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/dataset app/server   (log: /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/server.log)
+ curl http://127.0.0.1:57271/health
{
    "version": "arra-oracle-v4 26.9.20-alpha.1625",
    "auth": "bearer"
}

STEP_OK server-start
```

## Step 3. register 2 peers
alice and bob. `peer add` is a CLI alias over `kb registerPeer` (#31 R8).
```text
== 3. register 2 peers ==
+ bun app/cli.ts peer add --name alice
{
    "outcome": "created",
    "row": {
        "id": "ArO4r_Z3wI_DED4AKua-9",
        "name": "alice",
        "workspace_name": "default",
        "h_metadata": null,
        "internal_metadata": null,
        "configuration": null,
        "created_at": "2026-09-26T20:14:45.324Z"
    }
}

+ bun app/cli.ts peer add --name bob
{
    "outcome": "created",
    "row": {
        "id": "GmxvdVBUhHoK3NOcIGCTV",
        "name": "bob",
        "workspace_name": "default",
        "h_metadata": null,
        "internal_metadata": null,
        "configuration": null,
        "created_at": "2026-09-26T20:14:45.381Z"
    }
}

STEP_OK register-peers
```

## Step 4. open a session and join both peers
`session add`, then two `kb joinSession` calls -- there is no alias for join yet, so this is the generic `kb <method>` grammar.
```text
== 4. open a session and join both peers ==
+ bun app/cli.ts session add --name daily-loop
{
    "outcome": "created",
    "row": {
        "id": "V1YG8Mn_VQe8kjRRCqhu-",
        "name": "daily-loop",
        "workspace_name": "default",
        "is_active": true,
        "h_metadata": null,
        "internal_metadata": null,
        "configuration": null,
        "created_at": "2026-09-26T20:14:45.431Z"
    }
}

+ bun app/cli.ts kb joinSession --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/join-alice.json
{
    "outcome": "created",
    "row": {
        "workspace_name": "default",
        "session_name": "daily-loop",
        "peer_name": "alice",
        "configuration": null,
        "internal_metadata": null,
        "joined_at": "2026-09-26T20:14:45.483Z",
        "left_at": null
    }
}

+ bun app/cli.ts kb joinSession --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/join-bob.json
{
    "outcome": "created",
    "row": {
        "workspace_name": "default",
        "session_name": "daily-loop",
        "peer_name": "bob",
        "configuration": null,
        "internal_metadata": null,
        "joined_at": "2026-09-26T20:14:45.536Z",
        "left_at": null
    }
}

STEP_OK open-session
```

## Step 5. append an English message and a Thai message
alice writes English; bob replies in Thai containing ลืม INSIDE หลงลืม -- the R14 counterexample lives in ordinary chat too, not only the knowledge node published next.
```text
== 5. append an English message and a Thai message ==
+ bun app/cli.ts message append --session daily-loop --peer alice --role user --content Don't forget: snapshot the disk before the migration rehearsal.
{
    "outcome": "complete",
    "results": [
        {
            "index": 0,
            "outcome": "accepted",
            "row": {
                "id": "1",
                "public_id": "0uUmthFwmKqbj8foIVYV2",
                "workspace_name": "default",
                "session_name": "daily-loop",
                "peer_name": "alice",
                "content": "Don't forget: snapshot the disk before the migration rehearsal.",
                "token_count": "0",
                "seq_in_session": "1",
                "h_metadata": null,
                "internal_metadata": null,
                "created_at": "2026-09-26T20:14:45.592Z",
                "role": "user",
                "in_reply_to": null,
                "read": null,
                "read_at": null,
                "source_namespace": null,
                "source_message_id": null,
                "source_payload_digest": null,
                "source_created_at": null,
                "ingested_at": "2026-09-26T20:14:45.592Z"
            }
        }
    ],
    "stop": null
}

+ bun app/cli.ts message append --session daily-loop --peer bob --role assistant --content อย่าหลงลืมนะ ต้อง snapshot ดิสก์ก่อนซ้อมย้ายข้อมูลทุกครั้ง
{
    "outcome": "complete",
    "results": [
        {
            "index": 0,
            "outcome": "accepted",
            "row": {
                "id": "2",
                "public_id": "rbfyvYtW8I6urzvR72599",
                "workspace_name": "default",
                "session_name": "daily-loop",
                "peer_name": "bob",
                "content": "\u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21\u0e19\u0e30 \u0e15\u0e49\u0e2d\u0e07 snapshot \u0e14\u0e34\u0e2a\u0e01\u0e4c\u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e17\u0e38\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07",
                "token_count": "0",
                "seq_in_session": "2",
                "h_metadata": null,
                "internal_metadata": null,
                "created_at": "2026-09-26T20:14:45.657Z",
                "role": "assistant",
                "in_reply_to": null,
                "read": null,
                "read_at": null,
                "source_namespace": null,
                "source_message_id": null,
                "source_payload_digest": null,
                "source_created_at": null,
                "ingested_at": "2026-09-26T20:14:45.657Z"
            }
        }
    ],
    "stop": null
}

STEP_OK append-messages
```

## Step 6. seed the reserved 'type' vocabulary (R10: conclusion is a type term, not a table)
R10: `conclusion` is a reserved TYPE TERM, not a table. `kb seedReservedVocabularies` mints the sealed `type`/`memory_horizon` vocabularies with caller-supplied nanoid21 ids.
```text
== 6. seed the reserved 'type' vocabulary (R10: conclusion is a type term, not a table) ==
+ bun app/cli.ts kb seedReservedVocabularies --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/seed.json
{
    "outcome": "created",
    "vocabularies": [
        {
            "id": "d2Ef3lA-XV6t8bJCqwpsY",
            "name": "type",
            "workspace_name": "default",
            "label": "Type",
            "description": null,
            "kind": "categories",
            "term_policy": "sealed",
            "cardinality": "one",
            "required": true,
            "hierarchy": "flat",
            "h_metadata": null,
            "internal_metadata": null,
            "created_at": "2026-09-26T20:14:45.866Z"
        },
        {
            "id": "Vv6YOekf-1ZRix5WG3qlW",
            "name": "memory_horizon",
            "workspace_name": "default",
            "label": "Memory horizon",
            "description": null,
            "kind": "categories",
            "term_policy": "sealed",
            "cardinality": "one",
            "required": false,
            "hierarchy": "flat",
            "h_metadata": null,
            "internal_metadata": null,
            "created_at": "2026-09-26T20:14:45.866Z"
        }
    ],
    "terms": [
        {
            "id": "xu5fdnn9VYhzbZ9PVQZ70",
            "workspace_name": "default",
            "vocabulary_id": "d2Ef3lA-XV6t8bJCqwpsY",
            "name": "note",
            "description": null,
            "parent_id": null,
            "weight": 0,
            "is_active": true,
            "h_metadata": null,
            "created_at": "2026-09-26T20:14:45.866Z"
        },
        {
            "id": "nYfcl-Cep_1i17-Q-Bv9s",
            "workspace_name": "default",
            "vocabulary_id": "d2Ef3lA-XV6t8bJCqwpsY",
            "name": "conclusion",
            "description": null,
            "parent_id": null,
            "weight": 0,
            "is_active": true,
            "h_metadata": null,
            "created_at": "2026-09-26T20:14:45.866Z"
        },
        {
            "id": "mfHqz8NZnRV1gImUPL8w5",
            "workspace_name": "default",
            "vocabulary_id": "d2Ef3lA-XV6t8bJCqwpsY",
            "name": "learning",
            "description": null,
            "parent_id": null,
            "weight": 0,
            "is_active": true,
            "h_metadata": null,
            "created_at": "2026-09-26T20:14:45.866Z"
        },
        {
            "id": "c1mHoUCAa4-NcOepyqepV",
            "workspace_name": "default",
            "vocabulary_id": "d2Ef3lA-XV6t8bJCqwpsY",
            "name": "discussion",
            "description": null,
            "parent_id": null,
            "weight": 0,
            "is_active": true,
            "h_metadata": null,
            "created_at": "2026-09-26T20:14:45.866Z"
        },
        {
            "id": "VyAuptoNu42tWgq8T3_3C",
            "workspace_name": "default",
            "vocabulary_id": "d2Ef3lA-XV6t8bJCqwpsY",
            "name": "correction",
            "description": null,
            "parent_id": null,
            "weight": 0,
            "is_active": true,
            "h_metadata": null,
            "created_at": "2026-09-26T20:14:45.866Z"
        },
        {
            "id": "mnzIc-8hOjLiRWx6d4lD2",
            "workspace_name": "default",
            "vocabulary_id": "Vv6YOekf-1ZRix5WG3qlW",
            "name": "short_term",
            "description": null,
            "parent_id": null,
            "weight": 0,
            "is_active": true,
            "h_metadata": null,
            "created_at": "2026-09-26T20:14:45.866Z"
        },
        {
            "id": "c4vdvUhb-C7DMQN0B1nvy",
            "workspace_name": "default",
            "vocabulary_id": "Vv6YOekf-1ZRix5WG3qlW",
            "name": "long_term",
            "description": null,
            "parent_id": null,
            "weight": 0,
            "is_active": true,
            "h_metadata": null,
            "created_at": "2026-09-26T20:14:45.866Z"
        }
    ]
}

STEP_OK seed-vocab
```

## Step 7. look the reserved 'learning' type term up BY NAME (K2), the way a caller with no minted ids would
A caller who does NOT already know the ids resolves them by name instead -- `lookupVocabularyByName` then `lookupTermByName`, the v3-parity K2 reads, proven here the same way the v3 adapter itself uses them.
```text
== 7. look the reserved 'learning' type term up BY NAME (K2), the way a caller with no minted ids would ==
+ bun app/cli.ts kb lookupVocabularyByName --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/lookup-vocab.json
{
    "id": "d2Ef3lA-XV6t8bJCqwpsY",
    "name": "type",
    "workspace_name": "default",
    "label": "Type",
    "description": null,
    "kind": "categories",
    "term_policy": "sealed",
    "cardinality": "one",
    "required": true,
    "hierarchy": "flat",
    "h_metadata": null,
    "internal_metadata": null,
    "created_at": "2026-09-26T20:14:45.866Z"
}

+ bun app/cli.ts kb lookupTermByName --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/lookup-term.json
{
    "id": "mfHqz8NZnRV1gImUPL8w5",
    "workspace_name": "default",
    "vocabulary_id": "d2Ef3lA-XV6t8bJCqwpsY",
    "name": "learning",
    "description": null,
    "parent_id": null,
    "weight": 0,
    "is_active": true,
    "h_metadata": null,
    "created_at": "2026-09-26T20:14:45.866Z"
}

STEP_OK lookup-type-term
```

## Step 8. publish a knowledge node, type=learning, Thai body containing หลงลืม
`kb publishRevision`, type=learning, Thai body containing หลงลืม. The reserved type term from step 7 goes into `term_snapshot_json`, per contracts/revision-v1.md's 21-key envelope.
```text
== 8. publish a knowledge node, type=learning, Thai body containing หลงลืม ==
+ bun app/cli.ts kb publishRevision --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/publish-1.json
{
    "outcome": "accepted",
    "node_id": "rWzIGCoTjTOz_5Y21sNud",
    "revision_id": "PUrlZlGcISyn45WqoJ0Rw",
    "revision_no": "1",
    "content_digest": "af1913c6c35dcd4dc1539f6578283a94c8988ab61f313e03429dde03b8c89b0c",
    "node_created_at": "2026-09-26T20:14:46.120Z",
    "revision_created_at": "2026-09-26T20:14:46.120Z"
}

STEP_OK publish-node
```

## Step 9. index its chunks (search is a separate step from publish -- #30, 'index first')
`kb indexRevisionChunks` -- a SEPARATE step from publish. #30 / R8: 'index first, embed later, like backfill.'
```text
== 9. index its chunks (search is a separate step from publish -- #30, 'index first') ==
+ bun app/cli.ts kb indexRevisionChunks --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/index-1.json
{
    "outcome": "indexed",
    "rows": [
        {
            "id": "4c4d281870f9e88fa1f8a42cac32a8fc31f48e37640d70228ee2b2d3fcdc07d4",
            "workspace_name": "default",
            "node_id": "rWzIGCoTjTOz_5Y21sNud",
            "revision_id": "PUrlZlGcISyn45WqoJ0Rw",
            "chunk_index": "0",
            "text": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\n\n\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21\u0e01\u0e32\u0e23 snapshot \u0e14\u0e34\u0e2a\u0e01\u0e4c\u0e01\u0e48\u0e2d\u0e19\u0e1c\u0e48\u0e32\u0e15\u0e31\u0e14 (repartition/migrate) \u0e17\u0e33\u0e43\u0e2b\u0e49\u0e01\u0e39\u0e49\u0e04\u0e37\u0e19\u0e22\u0e49\u0e2d\u0e19\u0e01\u0e25\u0e31\u0e1a\u0e44\u0e21\u0e48\u0e44\u0e14\u0e49 -- \u0e17\u0e38\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07\u0e15\u0e49\u0e2d\u0e07 tmutil localsnapshot \u0e01\u0e48\u0e2d\u0e19\u0e40\u0e2a\u0e21\u0e2d",
            "content_hash": "f62864653b57e6cd4f4476c3323acd24a81211c5d1a102ed00be14d8e0168efe",
            "chunker_version": "chunker/v1",
            "embedding_profile": "ollama/all-minilm/384/none",
            "type_term_id": "mfHqz8NZnRV1gImUPL8w5",
            "term_ids": [
                "mfHqz8NZnRV1gImUPL8w5"
            ],
            "observer_peer_name": null,
            "subject_peer_name": null,
            "session_name": "daily-loop",
            "status": "pending",
            "attempts": "0",
            "last_attempt_at": null,
            "embedded_at": null,
            "error_code": null
        }
    ]
}

STEP_OK index-chunks
```

## Step 10. embed pending chunks with the real local Ollama, all-minilm
`kb embedPendingChunks` against the REAL local Ollama, model `all-minilm`. R20: the FIRST embed run against this dataset pins the model digest.
```text
== 10. embed pending chunks with the real local Ollama, all-minilm ==
+ bun app/cli.ts kb embedPendingChunks --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/embed.json
{
    "attempted": 1,
    "embedded": 1,
    "reused": 0,
    "failed": 0,
    "remaining": 0,
    "skipped": 0,
    "blocked": null
}

STEP_OK embed-chunks
```

## Step 11. getSearchFreshness (R20: show the pinned model digest)
R20 proof: `vectors.model_digest.pinned` now equals `last_measured` -- the digest measured moments ago in step 10.
```text
== 11. getSearchFreshness (R20: show the pinned model digest) ==
+ bun app/cli.ts kb getSearchFreshness --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/freshness.json
{
    "content": {
        "nodes": 1,
        "revisions": 1
    },
    "text_index": {
        "indexed_rows": 0,
        "unindexed_rows": 1
    },
    "vectors": {
        "profile_id": "ollama/all-minilm/384/none",
        "pending": 0,
        "ready": 1,
        "failed": 0,
        "last_attempt_at": "2026-09-26T20:14:46.313Z",
        "model_digest": {
            "pinned": "1b226e2802dbb772b5fc32a58f103ca1804ef7501331012de126ab22f67475ef",
            "last_measured": "1b226e2802dbb772b5fc32a58f103ca1804ef7501331012de126ab22f67475ef"
        }
    }
}

STEP_OK search-freshness
```

## Step 12. keyword search 'ลืม' -- Thai INSIDE a word (R14: ngram(3,3), not ICU)
R14 proof: ngram(3,3) finds ลืม INSIDE หลงลืม (`match:"ngram"`). ICU, which segments whole words, would have missed it -- that is the whole reason R14 overrode the SPEC's original 'icu' default.
```text
== 12. keyword search 'ลืม' -- Thai INSIDE a word (R14: ngram(3,3), not ICU) ==
+ bun app/cli.ts search --mode keyword --query ลืม --limit 5
{
    "match": "ngram",
    "scan_reason": null,
    "hits": [
        {
            "node_id": "rWzIGCoTjTOz_5Y21sNud",
            "revision_id": "PUrlZlGcISyn45WqoJ0Rw",
            "title": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25",
            "snippet": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\n\n\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21\u0e01\u0e32\u0e23 snapshot \u0e14\u0e34\u0e2a\u0e01\u0e4c\u0e01\u0e48\u0e2d\u0e19\u0e1c\u0e48\u0e32\u0e15\u0e31\u0e14 (repartition/migrate) \u0e17\u0e33\u0e43\u0e2b\u0e49\u0e01\u0e39\u0e49\u0e04\u0e37\u0e19\u0e22\u0e49\u0e2d\u0e19\u0e01\u0e25\u0e31\u0e1a\u0e44\u0e21\u0e48\u0e44\u0e14\u0e49 -- \u0e17\u0e38\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07\u0e15\u0e49\u0e2d\u0e07 tmutil loca",
            "chunk_ids": [
                "4c4d281870f9e88fa1f8a42cac32a8fc31f48e37640d70228ee2b2d3fcdc07d4"
            ],
            "score": 0.2506921887397766,
            "match": "ngram"
        }
    ]
}

STEP_OK keyword-search
```

## Step 13. semantic search over the same chunks
Same chunks, vector distance instead of an ngram rank; same embedding profile (`ollama/all-minilm/384/none`) pinned in step 10.
```text
== 13. semantic search over the same chunks ==
+ bun app/cli.ts search --mode semantic --query forgetting to snapshot the disk before a migration --limit 5
{
    "embedding_profile": "ollama/all-minilm/384/none",
    "metric": "l2_squared",
    "hits": [
        {
            "node_id": "rWzIGCoTjTOz_5Y21sNud",
            "revision_id": "PUrlZlGcISyn45WqoJ0Rw",
            "title": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25",
            "snippet": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\n\n\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21\u0e01\u0e32\u0e23 snapshot \u0e14\u0e34\u0e2a\u0e01\u0e4c\u0e01\u0e48\u0e2d\u0e19\u0e1c\u0e48\u0e32\u0e15\u0e31\u0e14 (repartition/migrate) \u0e17\u0e33\u0e43\u0e2b\u0e49\u0e01\u0e39\u0e49\u0e04\u0e37\u0e19\u0e22\u0e49\u0e2d\u0e19\u0e01\u0e25\u0e31\u0e1a\u0e44\u0e21\u0e48\u0e44\u0e14\u0e49 -- \u0e17\u0e38\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07\u0e15\u0e49\u0e2d\u0e07 tmutil loca",
            "chunk_ids": [
                "4c4d281870f9e88fa1f8a42cac32a8fc31f48e37640d70228ee2b2d3fcdc07d4"
            ],
            "distance": 1.467454195022583
        }
    ]
}

STEP_OK semantic-search
```

## Step 14. getContext for alice in daily-loop
`getContext` is a model-free read: alice's session messages, no model call, `coverage:"full"` because nothing was excluded.
```text
== 14. getContext for alice in daily-loop ==
+ bun app/cli.ts context get --peer alice --session daily-loop --max-items 10
{
    "items": [
        {
            "public_id": "rbfyvYtW8I6urzvR72599",
            "session_name": "daily-loop",
            "peer_name": "bob",
            "role": "assistant",
            "content": "\u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21\u0e19\u0e30 \u0e15\u0e49\u0e2d\u0e07 snapshot \u0e14\u0e34\u0e2a\u0e01\u0e4c\u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e17\u0e38\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07",
            "seq_in_session": "2",
            "created_at": "2026-09-26T20:14:45.657Z"
        },
        {
            "public_id": "0uUmthFwmKqbj8foIVYV2",
            "session_name": "daily-loop",
            "peer_name": "alice",
            "role": "user",
            "content": "Don't forget: snapshot the disk before the migration rehearsal.",
            "seq_in_session": "1",
            "created_at": "2026-09-26T20:14:45.592Z"
        }
    ],
    "coverage": "full",
    "excluded": [],
    "excluded_omitted": 0
}

STEP_OK get-context
```

## Step 15. chat ask, real local Ollama gemma3:4b (citations + coverage)
R9: the REAL local Ollama, model gemma3:4b. `items_used` is the citation list -- the message ids the model was actually shown, computed by the server, not parsed out of the model's prose.
```text
== 15. chat ask, real local Ollama gemma3:4b (citations + coverage) ==
+ bun app/cli.ts chat ask --peer alice --session daily-loop --max-items 10 --question What should I remember to do before a disk migration?
{
    "answer": "\u0e04\u0e38\u0e13\u0e15\u0e49\u0e2d\u0e07\u0e17\u0e33\u0e01\u0e32\u0e23 snapshot \u0e14\u0e34\u0e2a\u0e01\u0e4c\u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e17\u0e38\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07 [rbfyvYtW8I6urzvR72599].",
    "coverage": "full",
    "excluded": [],
    "excluded_omitted": 0,
    "items_used": [
        "rbfyvYtW8I6urzvR72599",
        "0uUmthFwmKqbj8foIVYV2"
    ]
}

answer: 'คุณต้องทำการ snapshot ดิสก์ก่อนซ้อมย้ายข้อมูลทุกครั้ง [rbfyvYtW8I6urzvR72599].'
citations (items_used): ['rbfyvYtW8I6urzvR72599', '0uUmthFwmKqbj8foIVYV2']
coverage: full
STEP_OK chat-ask
```

## Step 16. supersede node1 with a corrected revision (new node, R7 #29 lifecycle)
R7 / #29: supersede does not mutate a node in place. It publishes a brand-new node (step 16's `kb publishRevision`), then `kb supersedeNode` links old -> new with a reason, refusing unless the old node's head still matches `expected_revision_id`.
```text
== 16. supersede node1 with a corrected revision (new node, R7 #29 lifecycle) ==
+ bun app/cli.ts kb publishRevision --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/publish-2.json
{
    "outcome": "accepted",
    "node_id": "eDmd5AnE8Lt1rx2S4kFEA",
    "revision_id": "QoblP1OoYXwhNmvJ_gGgi",
    "revision_no": "1",
    "content_digest": "45522959e5e013ad757115d2f4450159163140282ea7395fc83e3efd12c7c1aa",
    "node_created_at": "2026-09-26T20:14:49.121Z",
    "revision_created_at": "2026-09-26T20:14:49.121Z"
}

+ bun app/cli.ts kb supersedeNode --file /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV/req/supersede.json
{
    "outcome": "accepted",
    "row": {
        "id": "1",
        "workspace_name": "default",
        "old_id": "rWzIGCoTjTOz_5Y21sNud",
        "old_revision_id": "PUrlZlGcISyn45WqoJ0Rw",
        "old_title": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25",
        "old_type": "learning",
        "old_source": null,
        "new_id": "eDmd5AnE8Lt1rx2S4kFEA",
        "new_revision_id": "QoblP1OoYXwhNmvJ_gGgi",
        "new_title": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25 (\u0e41\u0e01\u0e49\u0e44\u0e02)",
        "new_source": null,
        "reason": "corrected the Thai wording after review",
        "peer_name": "alice",
        "superseded_at": "2026-09-26T20:14:49.205Z",
        "operation_id": "demo-supersede-node1",
        "h_metadata": null
    }
}

STEP_OK supersede-node
```

## Step 17. nodes list (default) -- excludes the superseded node
The superseded node drops out of the DEFAULT listing (#29 R7: `listNodes` excludes retired/superseded nodes unless asked).
```text
== 17. nodes list (default) -- excludes the superseded node ==
+ bun app/cli.ts nodes list --limit 20
{
    "rows": [
        {
            "id": "eDmd5AnE8Lt1rx2S4kFEA",
            "workspace_name": "default",
            "current_revision_id": "QoblP1OoYXwhNmvJ_gGgi",
            "created_at": "2026-09-26T20:14:49.121Z",
            "updated_at": "2026-09-26T20:14:49.121Z",
            "title": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25 (\u0e41\u0e01\u0e49\u0e44\u0e02)",
            "revision_no": "1",
            "content_digest": "45522959e5e013ad757115d2f4450159163140282ea7395fc83e3efd12c7c1aa",
            "lifecycle_state": "active",
            "new_id": null
        }
    ],
    "next_after_id": null,
    "total": null
}

STEP_OK nodes-list-default
```

## Step 18. nodes list --history -- includes both the superseded node and its successor
`nodes list --history` shows both: the old node carries `lifecycle_state:"superseded"` and `new_id` pointing at the correction; the new node is `"active"`.
```text
== 18. nodes list --history -- includes both the superseded node and its successor ==
+ bun app/cli.ts nodes list --limit 20 --history
{
    "rows": [
        {
            "id": "eDmd5AnE8Lt1rx2S4kFEA",
            "workspace_name": "default",
            "current_revision_id": "QoblP1OoYXwhNmvJ_gGgi",
            "created_at": "2026-09-26T20:14:49.121Z",
            "updated_at": "2026-09-26T20:14:49.121Z",
            "title": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25 (\u0e41\u0e01\u0e49\u0e44\u0e02)",
            "revision_no": "1",
            "content_digest": "45522959e5e013ad757115d2f4450159163140282ea7395fc83e3efd12c7c1aa",
            "lifecycle_state": "active",
            "new_id": null
        },
        {
            "id": "rWzIGCoTjTOz_5Y21sNud",
            "workspace_name": "default",
            "current_revision_id": "PUrlZlGcISyn45WqoJ0Rw",
            "created_at": "2026-09-26T20:14:46.120Z",
            "updated_at": "2026-09-26T20:14:46.120Z",
            "title": "\u0e1c\u0e48\u0e32\u0e14\u0e34\u0e2a\u0e01\u0e4c: \u0e2d\u0e22\u0e48\u0e32\u0e2b\u0e25\u0e07\u0e25\u0e37\u0e21 snapshot \u0e01\u0e48\u0e2d\u0e19\u0e0b\u0e49\u0e2d\u0e21\u0e22\u0e49\u0e32\u0e22\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25",
            "revision_no": "1",
            "content_digest": "af1913c6c35dcd4dc1539f6578283a94c8988ab61f313e03429dde03b8c89b0c",
            "lifecycle_state": "superseded",
            "new_id": "eDmd5AnE8Lt1rx2S4kFEA"
        }
    ],
    "next_after_id": null,
    "total": null
}

STEP_OK nodes-list-history
```

## Step 19. v3 adapter: tools/list shows oracle_* tools (ARRA_MCP_V3_COMPAT=1)
ARRA_MCP_V3_COMPAT=1: 13 `oracle_*` tools are now advertised over the SAME `/mcp/:bank` endpoint the CLI's legacy commands and `kb_*` tools already use.
```text
== 19. v3 adapter: tools/list shows oracle_* tools (ARRA_MCP_V3_COMPAT=1) ==
+ curl -sS -X POST http://127.0.0.1:57271/mcp/default -H 'authorization: Bearer ***' -d '{"method":"tools/list",...}'
75 tools total, 13 oracle_*: oracle_ask, oracle_handoff, oracle_learn, oracle_read, oracle_research_note, oracle_search, oracle_search_chain, oracle_supersede, oracle_thread, oracle_thread_read, oracle_thread_update, oracle_threads, oracle_verify
STEP_OK v3-tools-list
```

## Step 20. oracle_learn: publish a v3-shaped learning node
The v3 adapter over raw MCP, not the CLI -- an existing v3 client's exact `oracle_learn` call shape still works against v4.
```text
== 20. oracle_learn: publish a v3-shaped learning node ==
+ curl -sS -X POST http://127.0.0.1:57271/mcp/default -H 'authorization: Bearer ***' -H "x-arra-peer: alice" -d '{"pattern":"arra-oracle-v4 overnight demo: the end-to-end loop finally runs, CLI and MCP both.","concepts":["demo","arra-v4"],"project":"github.com/Soul-Brews-Studio/arra-oracle-v4"}'   # tools/call oracle_learn
{
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
        "content": [
            {
                "type": "text",
                "text": "{\n  \"success\": true,\n  \"file\": null,\n  \"id\": \"1O0Meex44r1fZq70_IY-B\",\n  \"embedding\": \"enqueued\",\n  \"message\": \"Learning saved as v4 node 1O0Meex44r1fZq70_IY-B\",\n  \"compat_warnings\": [\n    {\n      \"code\": \"field_unavailable\",\n      \"field\": \"file\",\n      \"detail\": \"v4 writes no file; the learning is a node in LanceDB\"\n    }\n  ],\n  \"v4\": {\n    \"node_id\": \"1O0Meex44r1fZq70_IY-B\",\n    \"revision_id\": \"OiYWSvMgSgdGzF8HWp9eM\"\n  }\n}"
            }
        ]
    }
}

learned node: 1O0Meex44r1fZq70_IY-B
STEP_OK v3-oracle-learn
```

## Step 21. oracle_search: finds what oracle_learn just published
Finds the node `oracle_learn` just wrote. Default mode `hybrid` degrades to `fts` (R7: fusion is not carried; measured worse than either alone in relic's evaluation).
```text
== 21. oracle_search: finds what oracle_learn just published ==
+ curl -sS -X POST http://127.0.0.1:57271/mcp/default -H 'authorization: Bearer ***' -d '{"query":"arra-oracle-v4 overnight demo end-to-end loop","limit":5}'   # tools/call oracle_search
{
    "jsonrpc": "2.0",
    "id": 2,
    "result": {
        "content": [
            {
                "type": "text",
                "text": "{\n  \"results\": [\n    {\n      \"id\": \"1O0Meex44r1fZq70_IY-B\",\n      \"type\": \"learning\",\n      \"content\": \"arra-oracle-v4 overnight demo: the end-to-end loop finally runs, CLI and MCP both.\",\n      \"source_file\": null,\n      \"concepts\": [\n        \"demo\",\n        \"arra-v4\"\n      ],\n      \"score\": 1,\n      \"source\": \"fts\",\n      \"v4\": {\n        \"node_id\": \"1O0Meex44r1fZq70_IY-B\",\n        \"revision_id\": \"OiYWSvMgSgdGzF8HWp9eM\",\n        \"title\": \"arra-oracle-v4 overnight demo: the end-to-end loop finally runs, CLI and MCP bot\",\n        \"snippet\": \"arra-oracle-v4 overnight demo: the end-to-end loop finally runs, CLI and MCP bot\\n\\narra-oracle-v4 overnight demo: the end-to-end loop finally runs, CLI and MCP b\",\n        \"match\": \"ngram\",\n        \"matched_terms\": [\n          \"arra\",\n          \"oracle\",\n          \"overnight\",\n          \"demo\",\n          \"end\",\n          \"loop\"\n        ]\n      }\n    }\n  ],\n  \"total\": 1,\n  \"query\": \"arra-oracle-v4 overnight demo end-to-end loop\",\n  \"metadata\": {\n    \"mode\": \"hybrid\",\n    \"mode_effective\": \"fts\",\n    \"limit\": 5,\n    \"offset\": 0,\n    \"total\": 1,\n    \"sources\": {\n      \"fts\": 1,\n      \"vector\": 0,\n      \"hybrid\": 0\n    },\n    \"searchTime\": 52,\n    \"score_kind\": \"reciprocal_rank\",\n    \"match\": \"ngram\",\n    \"terms\": [\n      {\n        \"term\": \"arra\",\n        \"match\": \"ngram\",\n        \"scan_reason\": null\n      },\n      {\n        \"term\": \"oracle\",\n        \"match\": \"ngram\",\n        \"scan_reason\": null\n      },\n      {\n        \"term\": \"overnight\",\n        \"match\": \"ngram\",\n        \"scan_reason\": null\n      },\n      {\n        \"term\": \"demo\",\n        \"match\": \"ngram\",\n        \"scan_reason\": null\n      },\n      {\n        \"term\": \"end\",\n        \"match\": \"ngram\",\n        \"scan_reason\": null\n      },\n      {\n        \"term\": \"loop\",\n        \"match\": \"ngram\",\n        \"scan_reason\": null\n      }\n    ]\n  },\n  \"compat_warnings\": [\n    {\n      \"code\": \"semantic_change\",\n      \"field\": \"mode\",\n      \"detail\": \"hybrid fusion is not carried (keyword and semantic stay separate; fusing measured worse); answered by keyword search\"\n    },\n    {\n      \"code\": \"semantic_change\",\n      \"field\": \"query\",\n      \"detail\": \"v3 matched entries holding any word of the query (FTS5 OR); v4 searches each word as a substring and ranks entries holding more of the words first\"\n    },\n    {\n      \"code\": \"truncated\",\n      \"field\": \"query\",\n      \"detail\": \"words under 3 characters (in a query with longer ones) and words past the first 8 are not searched; ignored: v4 to\"\n    },\n    {\n      \"code\": \"field_unavailable\",\n      \"field\": \"source_file\",\n      \"detail\": \"v4 writes no file; the entry is a node in LanceDB (see id)\"\n    },\n    {\n      \"code\": \"semantic_change\",\n      \"field\": \"score\",\n      \"detail\": \"score is 1/(1+rank) in v4's order, not v3's fused relevance (metadata.score_kind)\"\n    }\n  ]\n}"
            }
        ]
    }
}

STEP_OK v3-oracle-search
```

## Step 22. oracle_thread: post as alice (speaker via X-Arra-Peer)
Speaker is asserted via the `X-Arra-Peer` header (A7/D8, R18), not a request field -- alice never appears in the JSON body itself.
```text
== 22. oracle_thread: post as alice (speaker via X-Arra-Peer) ==
+ curl -sS -X POST http://127.0.0.1:57271/mcp/default -H 'authorization: Bearer ***' -H "x-arra-peer: alice" -d '{"title":"demo: overnight loop chat","message":"[demo] posted through the v3 forum adapter over real MCP."}'   # tools/call oracle_thread
{
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
        "content": [
            {
                "type": "text",
                "text": "{\n  \"thread_id\": \"t-YdK9ZGtKWUo6RJZ9Y02FW\",\n  \"message_id\": \"lsHGxoyOXKwJKCGZtAOUr\",\n  \"status\": \"active\",\n  \"oracle_response\": null,\n  \"issue_url\": null,\n  \"compat_warnings\": [],\n  \"v4\": {\n    \"session_name\": \"t-YdK9ZGtKWUo6RJZ9Y02FW\",\n    \"seq\": \"1\",\n    \"outcome\": \"accepted\"\n  }\n}"
            }
        ]
    }
}

STEP_OK v3-oracle-thread
```

## Step 23. oracle_thread_read: read it back as alice
Read back as the SAME speaker. Membership is the read boundary (R3) even over the v3 adapter: a different X-Arra-Peer here would be refused.
```text
== 23. oracle_thread_read: read it back as alice ==
+ curl -sS -X POST http://127.0.0.1:57271/mcp/default -H 'authorization: Bearer ***' -H "x-arra-peer: alice" -d '{"threadId":"t-YdK9ZGtKWUo6RJZ9Y02FW"}'   # tools/call oracle_thread_read
{
    "jsonrpc": "2.0",
    "id": 4,
    "result": {
        "content": [
            {
                "type": "text",
                "text": "{\n  \"thread_id\": \"t-YdK9ZGtKWUo6RJZ9Y02FW\",\n  \"title\": \"demo: overnight loop chat\",\n  \"status\": \"active\",\n  \"message_count\": 1,\n  \"messages\": [\n    {\n      \"id\": \"lsHGxoyOXKwJKCGZtAOUr\",\n      \"seq\": \"1\",\n      \"role\": null,\n      \"author\": \"alice\",\n      \"content\": \"[demo] posted through the v3 forum adapter over real MCP.\",\n      \"timestamp\": \"2026-09-26T20:14:49.813Z\"\n    }\n  ],\n  \"next_cursor\": null,\n  \"compat_warnings\": [\n    {\n      \"code\": \"field_unavailable\",\n      \"field\": \"messages[].role\",\n      \"detail\": \"posted with no role; v4 keeps null rather than invent one\"\n    }\n  ],\n  \"v4\": {\n    \"session_name\": \"t-YdK9ZGtKWUo6RJZ9Y02FW\",\n    \"read_as\": \"alice\"\n  }\n}"
            }
        ]
    }
}

STEP_OK v3-oracle-thread-read
```

## Step 24. stop server and remove the mktemp stack
The trap runs on ANY exit -- success, a STEP_FAIL, or Ctrl-C -- so the server is always stopped and the mktemp stack always removed.
```text
== 24. stop server and remove the mktemp stack ==
+ kill -TERM 10105
+ rm -rf /var/folders/41/vsgzbn_93039tcq11v00hpl00000gv/T//arra-demo.Tm4DFV
STEP_OK stack-down

DEMO_DONE
```

## What this proves, and what it does not

- **Real, not stubbed**: every model call in this transcript hit a real
  local Ollama. `app/just/demo.test.ts` proves the SAME script's wiring
  against a stub, for CI, without a GPU.
- **All three transports**: the knowledge loop (steps 3-18) went only
  through the real CLI; the v3 loop (steps 19-23) went only through raw MCP
  JSON-RPC over curl. Nothing here calls a TypeScript kernel directly.
- **Not a benchmark**: the semantic search hit in step 13 and the chat
  answer in step 15 are real, single-example outputs, not a scored
  retrieval-quality run -- that is #7's job (`docs/overnight/DECISIONS.md`
  R16), explicitly deferred pending Nat's own relevance judgments.
- **Not exhaustive**: this is Nat's daily loop end to end, not every one of
  the 50+ `kb_*` methods. `.tmp/acceptor/live-probe/run.sh` (see the
  `probe_summary` in this slice's structured result) is the instrument that
  covers all of them.
