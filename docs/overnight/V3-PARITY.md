# Design: a v3-compatible MCP adapter for arra-oracle-v4 (#31 "legacy adapters")

**Version**: `v26.9.26-alpha.2150` · **Date**: 2026-09-26 21:50 GMT+7
**Status**: design only. This was read-only research: no tracked file was edited and no scratch file was written.

**Bases**
- v3: `arra-oracle-v3` at `61e5f8b6`.
- v4: `v4/overnight-26sep` at `fa8c7e5`. The registry has 31 methods at HEAD. It reaches 44 once the `expose-13` slice lands; that slice is still uncommitted in `wt/arra-oracle-v4-expose-13-26sep-sat2026`.

**Inputs**
- The three family reports (knowledge, forum, trace).
- `docs/overnight/DECISIONS.md` R1–R17.
- AGENTS.md "Chosen direction".
- `.tmp/understand/arra-oracle-v4_app-server_architecture_r.md`.
- `app/server/src/knowledge/registry.ts`.
- Checks I ran tonight.

**Paths**: v4 paths are relative to `app/server/src/` unless they start with `app/`. v3 paths are relative to the v3 repo root.

**Evidence tags**
- **[src]**: I read it at file:line tonight.
- **[run]**: I executed it tonight.
- **[rep]**: taken from a family report, using its citations; I did not re-read it.
- **[inf]**: my inference.
- **[D#]**: needs Nat's ruling (see §9).

---

## 0. Bottom line

- **v3 registers 30 MCP tools**, not 31 (`src/tools/mcp-manifest.ts:53-76` [src]).
  - The knowledge report counted 31. The families overlap on two groups: handoff/inbox (knowledge and forum) and mcp_call/mcp_list_tools (knowledge and trace).
- **Real usage** on this machine is 709 Claude Code tool calls to v3, under the server keys `oracle-v2` and `arra-oracle` [run].
  - Top tools: `oracle_search` **323 (46%)**, `oracle_learn` **187 (26%)**, `oracle_trace` 70, `oracle_handoff` 43, `oracle_thread` 25, `oracle_thread_read` 16, `oracle_trace_get` 12, `oracle_trace_list` 11.
  - 16 of the 30 tools were never called.
- **How the 30 tools map:**
  - **5 tools are 1:1:** one kernel method carries the meaning, and the adapter only translates.
  - **11 are thin compositions** of existing methods.
  - **8 need new kernel capability.**
  - **1 is static text.**
  - **5 are not carried.**
- **Before any new kernel work**, the adapter can serve 371 of the 709 real calls (52%).
- **The biggest single unlock is #30 wave 2 chunk search (K1).** It covers 46% of real calls and also unblocks `oracle_ask` and `oracle_search_chain`.
- **Every kernel addition** is either a read method or a grammar amendment over existing columns. No new table; the 19-table schema stays closed.
  - The one proposed write, `closeSession` (K9), needs a ruling [D7].
- **Exposure:**
  - The endpoint is the same `POST /mcp/:bank`.
  - v3 tool names are served unchanged.
  - Callers authenticate with an `arra-auth/v1` bearer token.
  - The only client change is that the `arra-oracle` entry moves from stdio to http. The config key stays, so `mcp__arra-oracle__oracle_*` names and permission allowlists keep matching.
- **Never carried:**
  - `oracle_mcp_call` and `oracle_mcp_list_tools`: they run a caller-chosen command on the server.
  - `oracle_trace_link` and `oracle_trace_unlink`: mutable edges on traces, which are immutable in v4.
  - `oracle_profile`: a hardcoded Thor profile, which is not knowledge.

---

## 1. Diagrams

### 1.1 Request path (new parts marked)

```text
 Claude Code: tool names unchanged, e.g. mcp__arra-oracle__oracle_learn
 .mcp.json "arra-oracle": type http, url http://127.0.0.1:3939/mcp/<bank>
   headers: Authorization: Bearer <64-hex>, X-Arra-Peer: <peer> (optional)
        |
        |  POST tools/call {name:"oracle_learn", arguments:{pattern,concepts,project}}
        v
+--------------------------------------------------+
| app.ts  POST /mcp/:bank                          |  Host/Origin guard, bank grammar
|   reads X-Arra-Peer header                (new)  |  256 KiB envelope cap
+--------------------------------------------------+
                          |
                          v
+--------------------------------------------------+
| auth/service.ts  runMcp                          |  arra-auth/v1: project the 4 actions
|   alias arra_x -> oracle_x                (new)  |  TOOL_ACTION = memory + kb_* + v3 (new)
|   asserted peer in grant peers[] (R3)     (new)  |  unknown == unpermitted -> 403
|   one audit row per tool call (mcp_calls)        |
+--------------------------------------------------+
                          |
                          v
+--------------------------------------------------+
| mcp/index.ts  dispatchTool                       |  rejects workspace_name, bank, workspace
|   oracle_* | ____IMPORTANT -> legacy-v3   (new)  |  + tenantId tenant_id tenant orgId org_id
+--------------------------------------------------+
                          |
                          v
+--------------------------------------------------+
| mcp/legacy-v3/tools/oracle_learn.ts       (new)  |  v3 args -> v4 payloads; kb() checks:
|   kb("lookupTermByName", ...)                    |    method is in the tool's `uses` list
|   kb("publishRevision", ...)                     |    method action <= admitted action
|   kb("indexRevisionChunks", ...)                 |    workspace_name := route bank
|   v4 result -> v3 shape + compat_warnings        |
+--------------------------------------------------+
                          |
                          v
+--------------------------------------------------+
| knowledge/registry.ts                            |  the same entry HTTP and kb_* use: governed
|   KNOWLEDGE_METHODS[m].call(bundle, bytes)       |  parser, requireWorkspace, domain checks
+--------------------------------------------------+
                          |
                          v
        publication/* kernels -> LanceDB target19
        (ARRA_KNOWLEDGE_DATASET_ROOT; writes need the fd-42 writer gate)
```

### 1.2 Where the 30 tools land, weighted by real use

```text
 class               tools  calls  share  (# = 10 real calls)
 1:1 kernel method      5     96    14%  ##########
 thin composition      11    275    39%  ############################
 needs new kernel       8    338    48%  ##################################   <- oracle_search 323
 static text            1      0     0%
 not carried            5      0     0%
 ------------------------------------------------------------
 total                 30    709
```

**How the counts were measured** [run]:
- `rg -o '"name":"mcp__<key>__<tool>","input"'` over `~/.claude/projects/**/*.jsonl` (6.1 GB, 209 project directories), for the keys `oracle-v2` and `arra-oracle`.
- `arra_*` alias calls are counted under their `oracle_*` tool.
- This is usage evidence, not an exact count: subagent transcripts are included, and resumed transcripts may double-count.

### 1.3 Slice order

S is under one agent-day, M is 1–2 days, L is more than 2.

```text
 expose-13 (wave 1) -----> V0 frame (S) --+
                                          |
 K2 name lookups (S) ---------------------+--> V1 writes (M) --+--> V3 trace (M)
                                          |                    |
 K1 = #30 wave 2 chunk search (L) --------|--------------------+--> V5 search, ask, chain (M)
                                          |
 #29 include_inactive (wave 2) -----------+--> V2 reads (M)
                                          |
 R3 membership (wave 1) + K12a title (S) -+--> V4 forum (M)

 parity tail (each V is S and waits only on its kernel slice):
   K3+K4 listNodes term filter + updated-desc order (M) --> V6 list / inbox / recap
   K5 listTraces (M) -----------------------------------> V7 trace_list, chain forward, trace_get children
   K6+K7 term usage + knowledgeStats (M) ---------------> V8 concepts, stats (full)
   K8 answerFromKnowledge (L; needs K1 + R9 provider) --> V9 ask llm:true
   K9 closeSession [D7] + K10 + K11 (M) ----------------> V10 thread_update closed, threads filters, tail
 VA acceptance harness (S): written FIRST, all red; each V slice turns its own steps green
```

---

## 2. How the adapter is exposed

### 2.1 Endpoint and catalogue

- **Same route:** `POST /mcp/:bank` (`app.ts:141-220` [rep]). No new route.
  - `/mcp/:bank/:workspace` stays a fixed 400, so there is still no nested tenant.
- **One catalogue** holds the 8 memory tools, the `kb_*` tools and the v3 family. There are no name collisions:
  - v3 names are `____IMPORTANT` and `oracle_*`.
  - v4 names are the 8 memory names and `kb_*` (`mcp/tools.ts:15-133` [src]).
- **Family gate:** operator configuration `ARRA_MCP_V3_COMPAT=1`, read in `composition.ts` as trusted configuration, not request data. It defaults to off until VA passes, and is on in the dev stack [D10].
- **Per-tool advertising.** #31 says "unsupported/proposed interfaces are not advertised as live". A v3 tool is listed only when all three hold:
  - (a) the principal holds the tool's action;
  - (b) a knowledge dataset is configured;
  - (c) every method in the tool's `requires` list exists in `KNOWLEDGE_METHODS`.

  Rule (c) is data-driven: `oracle_search` appears by itself once #30 wave 2 adds its registry entries. Rules (b) and (c) also avoid, for this family, the existing hazard that `kb_*` tools are advertised even when `ARRA_KNOWLEDGE_DATASET_ROOT` is unset (`mcp/tools.ts:118-133` [src]).
- **Calling a tool that is not listed:**
  - If the principal lacks the action, the answer is 403, the same as for an unknown tool (R8).
  - If the principal holds the action but the tool is not yet available, the answer is `isError` with `arra-v3-compat/1` `not_yet_available`.
  - Not-carried tools have no catalogue entry at all, so they are unknown and return 403.
- **Descriptions are rewritten for v4, not copied from v3.** Each one states its semantic changes, for example "superseded and retired entries are excluded from results".
- **The family is MCP-only by design.** It exists for Claude configurations; HTTP and CLI already expose the native `kb` methods (R8). Because the compositions only call registry methods, no business rule becomes specific to one transport.

### 2.2 Auth: `arra-auth/v1` action per tool

The service owns the map. It is derived from `mcp/legacy-v3/catalogue.ts` exactly the way `KNOWLEDGE_TOOL_ACTION` is derived from the registry (`auth/service.ts:134-143` [src]). The adapter never chooses its own grant.

| Action | Tools |
|---|---|
| `content:read` | `____IMPORTANT`, `oracle_search`, `oracle_ask`, `oracle_read`, `oracle_list`, `oracle_stats`, `oracle_concepts`, `oracle_reflect`, `oracle_recap`, `oracle_inbox`, `oracle_threads`, `oracle_thread_read`, `oracle_trace_get`, `oracle_trace_list`, `oracle_trace_chain` |
| `content:write` | `oracle_learn`, `oracle_research_note`, `oracle_handoff`, `oracle_supersede`, `oracle_thread`, `oracle_thread_update`, `oracle_trace`, `oracle_trace_distill`, `oracle_search_chain` (it writes traces), `oracle_verify` (`reconcileSearchChunks` is content:write under R8) |

- **`oracle_stats` is `content:read`, not `diagnostics:read`.** The knowledge report proposed diagnostics:read. I rule content:read for two reasons:
  - Counts by type term disclose content.
  - A diagnostics tool must not call content methods (the kb() rule in A1).

  K7 is therefore also content:read.
- **`oracle_ask` is `content:read`,** following R9.
- **v3's "read-only mode" becomes a grant holding only `content:read`.** Write tools are then absent from `tools/list`, and calling one returns 403, which looks the same as an unknown tool.

### 2.3 Client configuration: the only change a v3 user makes

**Today** [run, redacted]:
- `arra-oracle` is `{"type":"stdio","command":"bun","args":[".../arra-oracle-v3/bin/mcp.ts"]}`.
- Older sessions used the key `oracle-v2`.
- A v4 http entry already exists in the neo-oracle project: `arra-v4` pointing at `http://127.0.0.1:3939/mcp/<bank>`.

**After:**

```json
"arra-oracle": {
  "type": "http",
  "url": "http://127.0.0.1:3939/mcp/<bank>",
  "headers": { "Authorization": "Bearer <ARRA_TOKEN>", "X-Arra-Peer": "<peer name, optional>" }
}
```

- **Keep the key** (`arra-oracle`, or `oracle-v2` for older setups). Claude Code names tools `mcp__<key>__<tool>`, so tool names, `permissions.allow` entries and skills that mention them keep working.
- **The token** is a 64-hex bearer issued in the policy file, the same grammar as `cli.ts:79-86`. Do not commit it; keep the entry in user scope if the client cannot expand env vars [inf].
- **Transport differences:**
  - v4 MCP is stateless POST with JSON replies: no `mcp-session-id`, no GET/SSE.
  - v3's streamable HTTP kept sessions (`src/routes/mcp/streamable.ts` [src]).
  - VA must prove a real Claude Code handshake with auth; the unauthenticated `arra-v4` entry only shows the route is reachable.
- **No stdio shim is built into v4.** If one is wanted, bridging stdio to HTTP belongs on the client side.

### 2.4 Aliases [D6]

- v3 resolves inbound `arra_*` names to `oracle_*` (`src/mcp/aliases.ts:2,27-36` [src]).
- **Real use:** 29 calls (`arra_search` 21, `arra_learn` 4, `arra_read` 2, `arra_stats` 2). The last was on 2026-05-18, from the era when v3 *listed* `arra_*` names (rebrand commit `8b0b0373`) [run].
- **Proposal:**
  - Resolve inbound `arra_x` to `oracle_x` inside `auth/service.ts`, before the `TOOL_ACTION` lookup. The service owns name→action; an alias resolved in the adapter would pick its own grant.
  - Never list aliases.
  - The audit row records the canonical name plus `requested_as`.
  - `muninn_*` stays unknown; it is retired in v3 too.

### 2.5 Responses

- **Serialisation:** `text()` pretty-prints JSON with a 2-space indent and turns safe BigInts into numbers (`mcp/protocol.ts:54-69` [src]). That matches v3's `JSON.stringify(payload, null, 2)`.
  - `oracle_recap` returns a markdown string, as v3 did; `text()` passes strings through.
- **Shapes are v3's:** the same field names and JSON types that v3 clients read.
  - **Allowed additions:** `compat_warnings: [{code, field, detail}]` and a `v4` object carrying native ids.
  - **Removals are never silent.** A field v4 cannot fill is present as `null` and named in `compat_warnings`. #31 acceptance requires exactly this: "…or receive an explicit versioned incompatibility response, not silent field loss".
- **Warning codes (closed set):** `field_unavailable`, `argument_ignored`, `semantic_change`, `order_changed`, `partial`, `truncated`.
- **Conversions:**
  - Int64 decimal text becomes a number when v3 used a number and the value is safe (`total`, `depth`).
  - Timestamps use v3's format per field: ISO where v3 used ISO, epoch milliseconds where v3 did (`oracle_list.indexed_at`, `list.ts:125` [rep]).

### 2.6 Errors: the `arra-v3-compat/1` body

```json
{
  "success": false,
  "error": "Document not found: 3264052e-e8d4-4a64-a255-8e72b0e0979b",
  "compat": { "version": "arra-v3-compat/1", "code": "legacy_id_unknown",
              "tool": "oracle_read", "path": "/id", "detail": "v3 ids do not exist in v4" },
  "v4_error": null
}
```

- **How it travels:** the adapter throws a `CompatError` with `code`, `path` and `toJSON()`. `runMcp` already passes such an object through as exact JSON with `isError:true` and an audit row `status:"error"` (`auth/service.ts:490-527` [src]).
- **The `error` field carries v3-style text**, because v3 clients read `Error: <msg>` (v3 `server.ts:27,216-218` [rep]).
- **`compat.code` is a closed set:**
  - `not_carried`
  - `not_yet_available`
  - `legacy_id_unknown`
  - `speaker_required`
  - `unsupported_argument`
  - `semantic_refusal`
  - `no_results`
  - `kernel_error`, which wraps a v4 envelope in `v4_error` unchanged.

**Mapping v4 errors onto the v3 `error` text** (codes from `knowledge/transport.ts:125-157` [src]):

| v4 | v3-style `error` text |
|---|---|
| read returns `null` (v4 has no `not_found` on reads) | "Document not found: X" / "Trace X not found" / "Thread X not found" |
| `invalid_reference` | "<thing> not found" (parent trace, successor node, session, peer) |
| arra-error/v1 format codes, `invalid_request` | "Invalid input at <path>: <message>" |
| taxonomy `conflict` (409) | "name already taken by a different id" |
| returned `outcome:"conflict"` values | tool-specific (see supersede and trace replay); otherwise `kernel_error` |
| `writer_unavailable`, `recovery_required` | "Oracle is read-only or busy; retry" (retryable; v3's analogue was read-only mode) |
| `unsupported_dataset` | "knowledge dataset not configured" |
| `limit_exceeded` | "input too large at <path>" |
| `integrity_failure`, `worker_failure` | "internal integrity failure" (envelope kept) |
| `model_unavailable` (R9) | not an error: `oracle_ask` falls back to extractive, as v3 did |

---

## 3. Rules every adapter tool follows

**A1. Composition only.** A tool gets one capability, `kb(method, payload)`, and nothing else. `kb`:
1. Refuses any method not in the tool's static `uses` list (catalogue data, test-enforced).
2. Checks the action:
   - a `content:read` tool may call only `content:read` methods;
   - a `content:write` tool may call read or write methods, because the writer bundle includes the reads (`registry.ts:52-55` [src]).
3. Sets `workspace_name := ops.bank` at the method's `scopePath`, and refuses a payload that already names another workspace.
4. Encodes the payload to JSON bytes and calls `KNOWLEDGE_METHODS[m].call(bundle, bytes)`. This is the same governed parser HTTP and `kb_*` use.
   - `ephemeralWrite` methods go through the same helper, which is factored out of `mcp/index.ts:111-130` as `callKnowledgeMethod`.
5. Uses one bundle per tool call, from `knowledgeAccess.getBundle(tool.action)` (`knowledge/transport.ts:324-343` [src]).

What the adapter may and may not do:
- **It owns only** v3 argument translation and v3 output shaping. DESIGN.md:962: "Adapters must preserve semantics, not merely rename a response."
- **It does not own** domain validation, clock-driven rules, table access, or any import from `publication/*`.

**A2. Scope.**
- The bank comes from the route.
- Rejected argument keys:
  - `workspace_name`, `bank`, `workspace`: these already exist in `mcp/index.ts:59` [src].
  - v3's tenant carriers `tenantId`, `tenant_id`, `tenant`, `orgId` and `org_id` (v3 `src/mcp/tenant.ts:3` [rep]). These return `unsupported_argument`.
- `cwd` is not scope. It is ignored with `argument_ignored` ("cwd does not prove project ownership; pass project", AGENTS.md:30).

**A3. IDs** [D1, D9]
- **Objects the adapter creates expose v4 ids verbatim:**
  - `node_id` becomes v3 `id` / `learningId`;
  - the trace `id` becomes `trace_id`;
  - the session name becomes `thread_id`;
  - message `public_id` becomes the message `id`.
- **v3 corpus ids do not exist in v4**, because the v3 corpus is not imported (AGENTS rule 3). That covers `learning_2026-…`, UUID trace ids and integer thread ids. They return `legacy_id_unknown`.
  - Real clients do send them: `oracle_trace_get {traceId:"3264052e-…"}`, `oracle_thread_read {threadId:42}` [run].
- **v4-spike `memories` ids** (`m_<base36 ms>_<6>`, `db.ts:75` [src]) can become nodes under #34. The migration has no node mapping yet (`app/migrate-py/src/arra_migrate/rehearsal.py:364-373` [src]), so the derivation can still be agreed:
  - The resolver tries a direct nanoid21 node first. Otherwise it tries `legacy_node_id(ws,id) = base64url(sha256("arra-legacy-node/v1\n"+ws+"\n"+id))[0:21]`.
  - If both exist, it returns an error; it never picks one.
  - #34 must use a byte-identical derivation.
- **Advertised schemas:** `threadId: string|integer` (an integer is always `legacy_id_unknown`); `traceId: string`.

**A4. Taxonomy bootstrap** (every write needs it) [D2]
- **Reserved vocabularies** `type` and `memory_horizon`:
  - Resolve them by name with K2.
  - If they are absent, call `seedReservedVocabularies` with derived ids (idempotent).
  - Without K2, a workspace seeded by the UI or the migration under other ids cannot be found. `createTerm` returns `conflict /name` with no id (`service.createTerm.ts:58-65` [src]).
- **The adapter's own vocabularies** are open, `cardinality:many`, `required:false` and flat; that is the R17 policy #34 uses:
  - `concepts`: v3 concepts, plus the `handoff` tag;
  - `legacy_type`: R11's original type strings;
  - `project`: `owner/repo`, or `_universal` when a v3 call gave no project; `_universal` is v3's own convention.
- **Term creation:**
  - Missing terms in open vocabularies are created on demand; v3 concepts were free tags.
  - Term ids are derived from (ws, vocabulary name, term name), so `createTerm` replays as `already_satisfied`.
  - A `conflict/name` means someone else created the term; the adapter falls back to a K2 lookup.
- **Refusals:**
  - A sealed vocabulary refuses (R6). The result is `kernel_error` naming the concept; it is never silently dropped (DESIGN.md:1089).
  - If the workspace has a `required:true` vocabulary the adapter cannot fill, the result is `semantic_refusal` "workspace requires vocabulary X".
- **Names:** the adapter trims and de-duplicates them, as v3 did; the kernel does no normalization.

**A5. Type mapping (R11)**
- v3 `learning` maps to the reserved type `learning`.
- Every other v3 type (principle, pattern, retro, distillation, …) becomes type `note` plus a `legacy_type:<string>` term.
- A v3 `type` filter becomes the filter object `{type_term_id, all_term_ids:[legacy_type term]}`. That needs K1 for search and K3 for listing.

**A6. Recall versus browse** [D3]
- **Recall paths** (search, ask, search_chain, recap, reflect, inbox) show only recall-eligible nodes: not superseded and not retired (`getRecallEligibility`, R7 #29).
- **Browse paths** (read, list, trace_get's distilled links) use history mode and add `superseded_by`, `superseded_at` and `superseded_reason` from `listLifecycleHistory`.
- This is a deliberate change from v3's rule that superseded documents "still appear in search" (`supersede.ts:187` [rep]). Every recall tool description says so.

**A7. Speaker and attribution** [D8]
- **Where the speaking peer comes from:** a write that needs one takes it from, in order:
  1. a new optional tool argument `peer`;
  2. otherwise the connection header `X-Arra-Peer`.

  Both are caller assertions. When the grant lists `peers:[…]` (R3), the name must be in that list.
- **What it is never derived from:** the bearer, the user-agent or the cwd (AGENTS.md:28-30).
- **Writes that need it:**
  - forum writes and trace `peer_name`;
  - optionally, the author of learn, handoff and distill.
- **With no speaker:**
  - knowledge and trace writes publish with author and peer set to null;
  - forum writes fail `speaker_required`.
- **The speaker peer is ensured once per call:** `getPeer(name)`, or else `registerPeer {peer_id: derived nanoid21, name}`, which is idempotent.
- **Plumbing:** `app.ts` reads the header and passes it through `createMcpAdapter` and `runMcp` to `ops.assertedPeer`. The R3 check runs in auth, and the audit row fills `mcp_calls.peer_name`.

**A8. Retries**
- **Ids are random by default,** so two intentional `oracle_learn` calls still make two nodes, as in v3.
- **An optional `idempotency_key` argument** makes the ids deterministic: the publish `operation_id`, the trace `id`, the message `public_id`, the supersede `operation_id`. A client retry then replays as `already_satisfied`/`idempotent` instead of duplicating; v3 had no such guarantee.
- **Within one tool call,** ids are minted once up front, so an internal retry replays.

**A9. Size.** The MCP envelope is capped at 256 KiB (`app.ts:162` [rep]).
- Content larger than that gets `kernel_error limit_exceeded`, with a hint to use `POST /api/knowledge/:bank/publishRevision` (1 MiB cap).
- Real handoffs are a few KB [run samples].

---

## 4. The 30 tools

### 4.1 Summary

| v3 tool | real calls | class | v4 methods | slice / blocked on |
|---|---:|---|---|---|
| `oracle_search` | 323 | new kernel | K1 keyword / semantic | V5 / #30 wave 2 |
| `oracle_learn` | 187 | composition | K2, createVocabulary, createTerm, publishRevision, indexRevisionChunks | V1 / K2, expose-13 |
| `oracle_trace` | 70 | 1:1 | createTrace (+getTrace on the parent) | V3 / expose-13 |
| `oracle_handoff` | 43 | composition | K2, createTerm, publishRevision | V1 / K2 |
| `oracle_thread` | 25 | composition | getPeer, registerPeer, getSession, registerSession, joinSession, appendMessages, createSessionLink | V4 / R3, expose-13 |
| `oracle_thread_read` | 16 | 1:1 | getSession, listMessages (+R3 requester) | V4 / R3 |
| `oracle_trace_get` | 12 | composition | getTrace, listTraceHits, scanDependents, getAcceptedHead | V3; children and next need K5 |
| `oracle_trace_list` | 11 | new kernel | K5 listTraces | V7 / K5 |
| `oracle_threads` | 6 | 1:1 (degraded) | listSessions | V4; K10 for filters and recency |
| `oracle_stats` | 6 | composition (partial) | listNodes(include_total) → K7 | V2 partial, V8 full |
| `oracle_read` | 4 | 1:1 | getAcceptedHead (+listLifecycleHistory) | V2 / expose-13 |
| `oracle_list` | 2 | composition (degraded) | listNodes + getAcceptedHead ×N | V2; V6 with K3/K4 |
| `oracle_inbox` | 2 | new kernel | K3+K4 listNodes, getAcceptedHead | V6 |
| `oracle_thread_update` | 2 | new kernel (for `closed`) | getSession; K9 closeSession | V4 partial, V10 / K9 [D7] |
| `oracle_supersede` | 0 | composition | getAcceptedHead ×2, listLifecycleHistory, supersedeNode | V2 / #29 |
| `oracle_research_note` | 0 | composition | as learn, plus revision_links | V1 |
| `oracle_reflect` | 0 | composition | listNodes (random after_id), getAcceptedHead | V2; principles need K3 |
| `oracle_trace_chain` | 0 | composition | getTrace walk; K5 for forward | V3 backward, V7 forward |
| `oracle_trace_distill` | 0 | composition | getTrace, K2, publishRevision(derived_from), indexRevisionChunks | V3 |
| `oracle_verify` | 0 | 1:1 | reconcileSearchChunks | V2 |
| `oracle_ask` | 0 | new kernel | K1 (llm:false) / K8 (llm:true) | V5 / V9 |
| `oracle_search_chain` | 0 | new kernel | K1 semantic by text and by vector, listSearchChunks, createTrace | V5 |
| `oracle_concepts` | 0 | new kernel | K6 listTermUsage | V8 |
| `oracle_recap` | 0 | new kernel | K3+K4 | V6 |
| `____IMPORTANT` | 0 | static | none | V0 |
| `oracle_profile` | 0 | not carried [D5] | – | – |
| `oracle_trace_link` | 0 | not carried | – | – |
| `oracle_trace_unlink` | 0 | not carried | – | – |
| `oracle_mcp_list_tools` | 0 | not carried, ever | – | – |
| `oracle_mcp_call` | 0 | not carried, ever | – | – |

v3 plugins `oracle_dig` and `oracle_sessions` are out of scope: they are not built-ins (`src/plugins/oracle-dig/plugin.json` [rep]). Their v4 home is the read-only Relic adapter (R7 #28).

### 4.2 The 1:1 tools: one kernel method carries the meaning

#### `oracle_trace` (70 calls; content:write; slice V3)

**v3:** input `src/tools/trace.ts:29-50`, output `:167-183`, store `trace/store.ts:18-66` [rep].

**v4 calls:** `createTrace`, plus `getTrace` on the parent to compute depth.

**Input translation:**
- `query` is trimmed. A blank query gets v3's usage error.
- `id`: a random nanoid21, or one derived from `idempotency_key`.
- `name`: `slug(query)` + `-` + `id[0..6]`, at most 256 bytes.
- `parent_id` = `parentTraceId`. It must be a nanoid21, otherwise `legacy_id_unknown`.
- `prev_id` = a new optional `prevTraceId`, which replaces `oracle_trace_link`.
- `depth` = parent ? parent.depth + 1 : `"0"`. The kernel does not check it (K13).
- `status`: `"complete"`.
- `peer_name`: the speaker or null. `session_name`: null.
- `session_id`: `sessionId` namespaced as `claude-code:<uuid>`, or null.
- `mode`, `confidence`, `friction_score`, `session_from_ts` and `session_to_ts`: null.
- `h_metadata`:
  ```text
  {project, query_type, scope, agent_count, duration_ms,
   legacy: {found_files, found_retrospectives, found_learnings, found_resonance,
            unrepresentable_commits, unrepresentable_issues}}
  ```
- `internal_metadata`: `{"adapter":"arra-v3-compat/1"}`.

**Hits:** at most 256 (`limit_exceeded` beyond).
- **Commit hit:** `{kind:"commit", target:{repo, commit:{algorithm: 40 hex → sha1, 64 hex → sha256, oid}}, ref: shortHash||hash, excerpt: message, note:"date=<date>"}`.
  - Only when `project` parses to `owner/repo` (`github.com/o/r` or `o/r`) and the hash is full length. Real projects include `laris-co/homelab.wt-2`, which does not parse and goes to `unrepresentable_commits` [run].
- **Issue hit:** `{kind:"issue", target:{repo, number:"<n>", url: url ?? https://github.com/<repo>/issues/<n>}, ref:"#<n>", excerpt: title, note:"state=<state>"}`.

**Output:** `{success:true, trace_id, depth, summary:{file_count, commit_count, issue_count, total_dig_points}, message, compat_warnings, v4:{hits_written, legacy_unindexed}}`.
- `summary` is counted from the v3 input arrays, exactly as v3 counted it.

**Deliberate changes:**
- An unknown parent is now an error. v3 dropped it silently (`store.ts:31-36` [rep]).
- `foundLearnings` text is not written to ψ (`learning-files.ts:30-75` [rep]). A warning says "call oracle_trace_distill".
- `foundFiles`, retrospectives and resonance are not indexed as hits, because there is no local-path target kind (`contracts/evidence-v1.ts:37-57` [src]).

#### `oracle_thread_read` (16 calls; content:read; slice V4)

**v3:** input `src/tools/forum.ts:88-99`, output `:271-281` [rep].

**v4 calls:** `getSession`, then `listMessages {after_seq, limit ≤100, requester_peer_name: speaker}`. The `requester_peer_name` part is R3 and is not at HEAD: the closed keys are `workspace_name, session_name, after_seq, limit` (`publication/context.parseListMessages.ts:18-22` [src]).

**Input:**
- `threadId` is the session name. An integer returns `legacy_id_unknown`.
- `limit` means v3's "last N":
  - walk forward at most 10 pages (1000 messages) and keep the tail;
  - beyond that, return `truncated`;
  - once K11 exists, read the tail directly.

**Output:** `{thread_id, title, status: active|closed, message_count, messages:[{id: public_id, seq, role, author: peer_name, content, timestamp}], next_cursor}`.
- `title` comes from `h_metadata.title` once K12a exists, otherwise null.
- `message_count` is exact when the walk was exhausted, otherwise null.

**Rules:**
- No speaker returns `speaker_required`, because R3 needs a requester unless the caller holds audit:read.
- Reading never moves the read cursor (`read-cursor-v1.md:10` [rep]).

#### `oracle_threads` (6 calls; content:read; slice V4 degraded, V10 full)

**v4 call:** `listSessions {after_name, limit ≤100, include_total:true}`, ordered by name ascending (`service.listSessions.ts:24-28` [rep]).

**Input:**
- `status`: `active` and `closed` are filters on `is_active`, applied after the page is read. A warning says the page may come back short and that `total` counts before the filter.
- `status` `answered` and `pending` return `semantic_refusal`.
- `offset > 0` returns `unsupported_argument`; use `next_cursor` instead.

**Output:** `{threads:[{id: name, title, status, message_count:null, last_message:null, created_at, issue_url:null}], total, next_cursor}`, with an `order_changed` warning until K10.

**Note:** every session in the bank lists as a thread. A session is the single shape for channel, thread and DM; there is no table per content type. K10's `member_peer_name` narrows the list to the speaker's own threads.

#### `oracle_read` (4 calls; content:read; slice V2)

**v3:** `src/tools/read.ts:21-37` (keys `file` and `id`), outputs `:196-228` [rep, key names src].

**v4 calls:** resolve the id (A3), then `getAcceptedHead`. Add `listLifecycleHistory {limit:1}` when the node is no longer eligible.

**Input:**
- `file` returns `not_carried`: v4 does no server file reads, because LanceDB is canonical.
- Neither key present returns `unsupported_argument`. Real callers sent `file_path` [run].

**Output:** `{content: body, title, source_file:null, resolved_path:null, source:"node", project, superseded_by?, superseded_at?, superseded_reason?, v4:{node_id, revision_id, revision_no}}`.
- A null head returns "Document not found: <id>".

**Change:** the result is one node body, not a whole markdown file with frontmatter.

#### `oracle_verify` (0 calls; content:write; slice V2)

**v4 call:** `reconcileSearchChunks {limit:1024}`.

**Output mapping:**
- `healthy` = visited − missing − stale.
- `missing` = missing.
- `drifted` = stale.
- `orphaned` and `untracked` = null, with a `field_unavailable` warning.
- `missing[]` = `missing_revisions`.
- `recommendation`: "run indexRevisionChunks for missing_revisions".
- `exhausted:false` produces a `partial` warning.

**Not carried:**
- `check:false` returns `not_carried`: it wrote `superseded_by='_verified_orphan'`, which invents a successor.
- `type` returns `argument_ignored`.

### 4.3 Thin compositions of existing methods

#### `oracle_learn` (187 calls; content:write; slice V1)

**v3:** input `src/tools/learn.ts:48-74`, output `:307-318`, errors `:152-185` [rep].

**v4 calls:** the A4 bootstrap, then optionally ensure the speaker peer, then `publishRevision {operation_id, content}`, then `indexRevisionChunks`.

**Input:**
- `pattern` is required and must not be blank; this is v3's rule, kept as an adapter input rule.
- `concepts[]` become `concepts` terms.
- `project` is normalized to `owner/repo` (v3 `normalizeProject`, `learn.ts:84-105`) and becomes a `project` term; with no project, `_universal`.
- `source` goes into `fields` as `{"source": …}`.

**Content envelope** (the 21 keys of `contracts/revision-v1.ts:53-61` [src]):
- `node_id`: a new nanoid21. `base_revision_id`: null.
- `title`: the first line, up to 80 characters. `body`: pattern. `body_format`: `markdown`.
- `author_peer_name`: the speaker or null. `observer_peer_name`, `subject_peer_name`, `session_name`: null.
- `is_active`: true. `valid_from`, `valid_to`, `change_reason`: null.
- `schema_version` and `canonical_version`: the revision-v1 constants.
- `term_snapshot_json`: type `learning`, plus the concepts, plus one project term.
- `link_snapshot_json`: `"[]"`.
- `h_metadata`: null. `internal_metadata`: `{"created_by":"oracle_learn/arra-v3-compat/1"}`.

**Indexing:** `indexRevisionChunks {node_id, revision_id, chunker_version, embedding_profile}`, using the server's configured constants. The caller never chooses them.

**Output:** `{success:true, file:null, id: node_id, embedding:"enqueued"|"failed", embeddingError?, message, v4:{node_id, revision_id}}`.
- If indexing throws after the publish, the call still succeeds, with `embedding:"failed"`. The publish stands, and `reconcileSearchChunks` reports the revision as missing. This keeps v3's rule that embedding never blocks the write (`learn.ts:263-305` [rep]).

**Changes:**
- No ψ markdown file is written.
- There is no fallback to the server's own repo as the project (`learn.ts:204-206` [rep]).
- The embedding is enqueued and filled later by the backfill worker (R8).

#### `oracle_research_note` (0 calls; content:write; slice V1)

**v3:** `src/tools/oracle.ts:40-63`; rendering in `research/note.ts:63-81` [rep].

**v4:** the same chain as learn. The body comes from a port of `buildResearchNoteLearning`, which is pure presentation.

**Links:**
- URL evidence becomes `{relation:"supports", target_kind:"url", target:{url}, excerpt: summary, capture_status:"locator_only", captured_at:null, content_hash:null, note: title}`.
- `repo` + `issue` becomes `{relation:"discusses", target_kind:"issue", target:{repo, number, url}}`. `url` is required.
- Path-only repo evidence stays in the body, because a `code` target needs a full commit.

**Tags:**
- The automatic tag `dev-research` is kept.
- `thor-oracle` and `stormforge` are dropped: they are profile defaults, and v4 has no profile registry (AGENTS rule 4). A warning says so.

**Type:** `learning`, for parity [D4].

#### `oracle_handoff` (43 calls; content:write; slice V1)

**v3:** `src/tools/handoff.ts:21-38,91-139` [rep].

**v4:** `publishRevision` with:
- type `note`, `concepts:handoff`, `memory_horizon:short_term`;
- a project term from a new optional `project` argument, otherwise `_universal`;
- `title` = slug, or the first heading or line (up to 80 characters); `body` = content;
- author = the speaker or null;
- `session_name` = the new optional `session` argument, otherwise null.

`handoff` is a tag term, never a type: the `type` vocabulary is sealed and reserved (R6).

**Output:** `{success:true, file:null, id: node_id, message}`.

**v3 defects that disappear:**
- a traversable slug (D2);
- a write directory the inbox never read (D3);
- same-minute overwrite (D4).

#### `oracle_supersede` (0 calls; content:write; slice V2)

**v3:** `src/tools/supersede.ts:50-71,133-189` [rep].

**v4 calls:** resolve both ids, `getAcceptedHead` on both, `listLifecycleHistory {node_id: old, limit:1}`, then `supersedeNode`.

**Pre-check** with `listLifecycleHistory`:
- Old node already superseded by the same successor: v3's `unchanged:true`.
- Already superseded by a different successor: v3's "already superseded by X".

**The `supersedeNode` request:**

| Field | Value |
|---|---|
| `workspace_name` | the bank |
| `node_id` | the old node |
| `expected_revision_id` | the old node's head |
| `new_node_id` | the new node |
| `new_revision_id` | the new node's head |
| `reason` | `reason ?? "v3 adapter: reason not recorded"` (v4 requires it; `lifecycle.ts:122-128` [rep]) |
| `peer_name` | the speaker or null |
| `operation_id` | `"v3-supersede:"+old+":"+expected_rev+":"+new` |

**Outcomes:**
- `stale_pin`: re-read and retry once.
- Self, cycle, or a successor that is already inactive (R7 #29): `semantic_refusal` with v3-like text.

**Output:** v3's `{success, old_id, old_type, new_id, new_type, reason, superseded_at, message}`.
- `old_type`/`new_type` come from the type term, or from `legacy_type` if present.
- The message says "excluded from recall; still readable by id and history".

#### `oracle_reflect` (0 calls; content:read; slice V2)

**v4 calls:**
1. `listNodes {after_id: random nanoid21, limit:1, include_total:false, type_term:"learning"}`, wrapping to `after_id:null` once if nothing comes back. #29 already excludes inactive nodes by default.
2. `getAcceptedHead`.

**Output:** `{principle:{id, type, content, source_file:null, concepts}}`. An empty workspace returns `no_results`; v3 threw.

v3 sampled principles too. That needs K3 (`type note` plus the `legacy_type:principle` term); until then it samples learning only, with a warning.

#### `oracle_list` (2 calls; content:read; slice V2 degraded, V6 full)

**v4 calls:** `listNodes {after_id, limit ≤100, include_total:true, type_term, include_inactive:true}` (history mode is R7 #29). Then `getAcceptedHead` per row, at most 100, to fill `content[:500]`, type and concepts. Lifecycle flags come only for rows that are not eligible.

**Input:**
- `type:learning` becomes `type_term:"learning"`.
- Other types become `type_term:"note"` plus a `legacy_type` filter applied after the page, within the kernel's scan window.
- `offset` is emulated by walking pages, at most 10.
- `asOf` returns `unsupported_argument`, because there is no historical browse.

**Output:** v3's `{documents:[{id, type, title, content, source_file:null, concepts, indexed_at: epoch ms of nodes.updated_at}], total, limit, offset, type}` plus `next_cursor`.
- `total` is null, with a `partial` warning, whenever it is not exact.
- The order is by id, not newest first, with an `order_changed` warning until K4.

#### `oracle_stats` (6 calls; content:read; slice V2 partial, V8 full)

**Before K7:**
- `total_documents` from `listNodes {include_total:true, limit:1}`.
- `version` from `SERVER_VERSION`.
- Every other field null, with `partial`.

**After K7:**
- `by_type`, `fts_indexed` (chunk count), `unique_concepts` and `last_indexed` all come from K7.
- `vector_status` comes from the per-profile counts of embedded vs pending vs failed chunks.

#### `oracle_trace_get` (12 calls; content:read; slice V3)

**v3:** `src/tools/trace.ts:68-79,240-278` [rep].

**v4 calls:**
- `getTrace`. Null returns "Trace X not found": `legacy_id_unknown` for a non-nanoid id.
- `listTraceHits`: at most 2 pages of 200.
- `scanDependents {target_kind:"trace", target:{trace_id}, revision_mode:"current"}`, keeping `derived_from`, then `getAcceptedHead` to read the body used as the awakening text.
- With `includeChain`: walk `getTrace` up `parent_id`, at most 1024 steps.

**Output:**
- `found_commits` and `found_issues` are rebuilt from the hits.
- The other `found_*` arrays come from the `h_metadata.legacy` block.
- `distilled_to_ids[]` is returned; `distilled_to_id` is its first entry, with `distilled_count` (DESIGN.md:720).
- `status` is derived: `distilled` if there is at least one `derived_from` dependent, otherwise `raw`.
- `child_trace_ids` and `next_trace_id` are null, with `field_unavailable`, until K5.
- `updated_at` = `created_at`, because traces are immutable.

#### `oracle_trace_chain` (0 calls; content:read; slice V3 backward, V7 forward)

**Backward:** walk `getTrace` along `prev_id`, at most 1024 steps (`service.assertTraceChain.ts` [rep]).

**Forward** needs K5 (`prev_id = X`):
- With several successors, stop and return `forked:true, branches:[…]`, because v4 allows forks.
- Until K5: `forward:"unavailable"`.

An unknown start returns `{chain:[], position:0, chain_length:0}`, as in v3.

#### `oracle_trace_distill` (0 calls; content:write; slice V3)

**v3:** `src/tools/oracle.ts:20-38`; `trace/distill.ts:93-130` [rep].

**v4 calls:** `getTrace`, the A4 bootstrap, `publishRevision`, then `indexRevisionChunks`.

**The node:**
- `type`: `learning` when `promoteToLearning` is set, otherwise `conclusion` (R10) [D4].
- `link_snapshot_json`: `[{position:"0", relation:"derived_from", target_kind:"trace", target:{trace_id}, capture_status:"locator_only", …nulls}]`.
- `change_reason`: "distilled from trace <id>".
- Concepts: `trace-awakening`, the theme, and the caller's concepts.
- `operation_id`: `"v3-distill:"+sha256(canonical input)`.

**Output:** `{success:true, status:"distilled", learningId (only when promoted), origin, concepts}`.

**Mismatches:**
- **The trace is never updated.** It is immutable, and v4 has no `distilled_to`/`distilled_at` column. "Distilled" is derived from the `derived_from` links instead.
- **Re-distilling adds a second node.** Replacing the first one is an explicit `oracle_supersede`.

**Not carried:**
- The `trace-<id>` concept: it would be a second authority for the edge.
- The Thor/Stormforge profile defaults.

**`origin`:** it becomes the author only when it is the bound speaker; otherwise it goes to `h_metadata.origin`.

#### `oracle_thread` (25 calls; content:write; slice V4)

**v3:** `src/tools/forum.ts:57-72,126-207`; `forum/handler.ts:178-202` [rep].

**New thread:**
1. Ensure the speaker (A7).
2. `registerSession {session_id: nanoid21, name: "t-"+nanoid21}`.
3. `joinSession` for the speaker, plus each peer in a new optional `to:[peer]` argument.
4. `appendMessages {items:[{public_id, message:{peer_name: speaker, role: role ?? null, content, in_reply_to:null}, source:null}]}`.

**Continue an existing thread:**
- `getSession`: null means not found; `is_active:false` means closed.
- Then `appendMessages`.
- A speaker who is not a member gets an error. The adapter never joins silently, because under R3 joining grants read access. An explicit `join:true` argument joins.

**`reopen:true` on a closed thread:**
1. Register a new session.
2. Join the speaker.
3. `createSessionLink {from: new, to: old, relation:"continues", created_by_peer_name: speaker}`.
4. Append the message.

Members cannot be carried over until K10 provides a membership read.

**Output:** `{thread_id, message_id: public_id, status, oracle_response:null, issue_url:null, compat_warnings}`.

**Warnings:**
- `title` is not stored until K12a. The session name is never derived from the title (DESIGN.md:369).
- `model` is not stored until K12b.
- Content is not trimmed, because v4 applies no normalization. v3's non-blank rule stays as an adapter input rule.

### 4.4 Tools that need new kernel capability

#### `oracle_search` (323 calls; content:read; slice V5, needs K1)

**v3:** `src/tools/search/definition.ts:1-59`, `handler.ts:170-175`, `search/types.ts:44-69` [rep].

**Input:**
- `mode`:
  - `fts` → keyword.
  - `vector` → semantic.
  - `hybrid` (the default) → keyword, with `metadata.mode_effective:"fts"` and a `semantic_change` warning: "fusion not carried; it measured worse" (R7).
- `type` → the A5 filter.
- `project` → `any_term_ids:[project P, _universal]`, which keeps v3's "project plus universal" (`fts.ts:24` [rep]).
- `model` → `argument_ignored`. All v3 models are non-384; the column is frozen at 384.
- `asOf` → `unsupported_argument`.
- `offset` → fetch `offset+limit` (bounded) and slice.
- `retrieval:"compact-summary"` → done in the adapter; it is presentation only.
- `cwd` → `argument_ignored` (A2).

**Output:** `{results, total, query, metadata}`.
- K1 returns chunks. The adapter keeps the best chunk per node.
- Each result: `id` = node_id; `type` = legacy_type if present, else the type term name; `content` = chunk text up to 500 characters; `source_file:null`; `concepts`; `score` (plus `metadata.score_kind`); `source` = `fts` or `vector`.
- `metadata` carries `match` (R14: `ngram` or `substring_scan`), `vectorAvailable` = (unembedded == 0), and the warnings.
- Recall excludes nodes that are not eligible (A6).

**Do not route to legacy `recall`.** `oracle_learn` writes target19, so recall over `memories` would split one fact across two writable stores.

#### `oracle_ask` (0 calls; content:read; slice V5, then V9)

- **`llm:false`:** K1 keyword, then v3's extractive answer, ported as pure presentation, with citations.
- **`llm:true`:** needs K8. Until K8 lands, and whenever `model_unavailable`/`writer_unavailable` comes back, the tool falls back to extractive with `mode:"extractive"` and a warning. That is v3's own fallback (`synthesis.ts:63-83` [rep]).
- **`answerChat` is not used:** it is grounded on session messages of one peer and session, not on knowledge nodes (`publication/chat.ts:12-18` [rep]).

#### `oracle_search_chain` (0 calls; content:write; slice V5)

**Hop 0:** K1 semantic by text.

**Each later hop:**
- `listSearchChunks {revision_id}` returns the stored embedding of the best hit.
- K1 semantic by vector over that embedding.
- Stop on score decay below 0.5, on a cycle, or on an empty result (v3 `search/chain.ts` [rep]).

**One trace per hop:** `createTrace {mode:"chain", prev_id: previous hop, depth:"N", status:"complete", hits:[{kind:"node_revision", target:{node_id, revision_id}, …}]}`.

**Output:** v3's `{query, maxHops, breadth, model, traceIds, hops[], results[]}`. `model` → `argument_ignored`.

#### The other five

- **`oracle_concepts` (0; K6):** `listTermUsage {vocabulary: concepts, type_term?}` returns `{concepts:[{name,count}], total_unique, filter_type}`. It is counted over current heads, with `coverage`.
- **`oracle_recap` (0; K3+K4):**
  - Markdown text: an identity line (server version, bank), then the newest eligible nodes grouped by project term, with `memory_horizon:long_term` first. The token budget is fitted in the adapter.
  - Heat ranking is not carried.
- **`oracle_inbox` (2; K3+K4):**
  - `listNodes {any_term_ids:[concepts:handoff], order:"updated_desc"}`, then `getAcceptedHead` for each preview.
  - Output: `{files:[{filename: title, path:null, created, preview: body[:500], type:"handoff"}], total, limit, offset}`.
  - v3's `type` argument is accepted as v3 dialect: `handoff` and `all` mean the same thing until K10/K11 add unread messages for `all`.
  - `retireNode` is never used as "read".
- **`oracle_trace_list` (11; K5):**
  - `query` becomes `query_contains`. The `status` filter is mapped: `raw` = no `derived_from` dependents, `distilled` = at least one. `reviewed` and `distilling` return `semantic_refusal`: an immutable trace has no review state.
  - Output: `{traces:[…], total:null, has_more}`. `has_awakening` comes from K5's `derived_from_count`.
- **`oracle_thread_update` (2; V4 partial, K9):**
  - `active` on an active thread: no-op success.
  - `active` on a closed thread: `semantic_refusal` pointing at `oracle_thread(reopen:true)`.
  - `closed`: K9, or `not_yet_available` until then.
  - `answered` and `pending`: `semantic_refusal`. Lifecycle is binary `is_active`; reply state is derived from the message stream and the read cursor. Both real calls used `answered` [run].
  - A missing thread is always an error. v3 reported success here (defect D1, `forum.ts:317-331` [rep]).

### 4.5 Static text

**`____IMPORTANT`** is served as v4 text by `mcp/legacy-v3/guide.ts`. It says:
- "Nothing is deleted" (writes are append-only);
- superseded and retired nodes leave recall;
- ids are v4 ids;
- there is no MCP bridge;
- which tools are not carried, and why.

---

## 5. New kernel capability

None of these adds a table. Each is a read method or a grammar amendment over existing columns in `TARGET_SCHEMA` (`publication/storage.ts:34-55` [src]). Each K slice owns:
- its `publication/<kernel>.parse<Method>.ts` and `publication/service.<method>.ts`;
- the facade wiring;
- a contract-doc amendment;
- one registry entry, added by the registry owner per R7.

| # | Capability | Action | Minimal design | Tables and columns used | Size |
|---|---|---|---|---|---|
| K1 | chunk search (#30 wave 2; already planned) | content:read | see below | `search_chunks_v1` (`type_term_id`, `term_ids`, `embedding[384]`), `nodes.current_revision_id`, `supersede_log.old_id` | L |
| K2 | `lookupVocabularyByName`, `lookupTermByName` | content:read | `{workspace_name, name}` / `{workspace_name, vocabulary_id, name}` → row or null | wraps the existing internals `service.lookupVocabularyByName.ts`, `service.lookupTermByName.ts` [src], today used only inside create/rename/seed | S |
| K3 | term filter on `listNodes` | content:read | new required-but-nullable closed keys `all_term_ids`, `any_term_ids`, next to `type_term` (`service.parseListNodes.ts:45` [src]) | `node_revision_terms` of the head revision; same lag disclosure as the existing `type_term` path (`listNodes.ts:108-116` [rep]) | M (with K4) |
| K4 | time order on `listNodes` | content:read | `order:"id_asc"|"updated_desc"`, plus `after_updated_at` as a keyset pair with `after_id` | `nodes.updated_at` (exists, `timestamp[us]`) | (in K3) |
| K5 | `listTraces` | content:read | see below | `traces.created_at` (int64 ms), `parent_id`, `prev_id`, `query`; `revision_links` for the count | M |
| K6 | `listTerms`, `listTermUsage` | content:read | see below | `terms`, `node_revision_terms`, `nodes` | M |
| K7 | `knowledgeStats` | content:read | see below | `nodes`, `node_revision_terms`, `search_chunks_v1.status`, `vocabularies`, `terms` | S–M |
| K8 | `answerFromKnowledge` | content:read (model injected, R9) | see below | K1's tables | L |
| K9 | `closeSession` [D7] | content:write | see below | `sessions.is_active`, `sessions.internal_metadata` | M |
| K10 | `listSessions` filters, `listSessionMembers` | content:read | see below | `sessions`, `session_peers` (today nothing reads `session_peers`) | M |
| K11 | tail read on `listMessages` | content:read | `direction:"asc"|"desc"` plus `before_seq` | `messages.seq_in_session` | S |
| K12 | display metadata | content:write | a) `registerSession` accepts `h_metadata:{title}`; b) `appendMessages` items accept `h_metadata:{model}` | `sessions.h_metadata`, `messages.h_metadata` (null-only today, `context-ingestion-v1.md:15,42` [rep]) | S |
| K13 | `createTrace` depth check | content:write | refuse when depth ≠ parent.depth + 1 (or ≠ 0 without a parent) | no new columns | S |

**Details that do not fit the table:**

- **K1 (chunk search).**
  - Methods and requests:
    - `searchChunksKeyword {workspace_name, query, limit≤100, filter}`
    - `searchChunksSemantic {workspace_name, query|null, vector|null (exactly one), embedding_profile, limit, filter}`
    - `filter = {type_term_id, all_term_ids, any_term_ids}`
  - Rows: `{node_id, revision_id, chunk_index, text, score}`, plus `match` (R14) and `unembedded`.
  - Head-only and recall-eligible **inside the kernel**, not in the adapter.
- **K5 (`listTraces`).**
  - Request: `{workspace_name, parent_id|null, prev_id|null, query_contains|null, after_created_at|null, after_id|null, limit≤100}`.
  - Rows ordered by `(created_at desc, id)`, each with `derived_from_count`. The count is computed from `revision_links (target_kind=trace, relation=derived_from)` joined to current heads, which avoids the O(nodes×rows) `scanDependents`.
  - `query_contains` is a bounded, escaped LIKE scan with `coverage` (R14 precedent).
- **K6 (terms).**
  - `listTerms {vocabulary_id, after_id, limit, include_inactive}`.
  - `listTermUsage {vocabulary_id, type_term|null, limit≤200}` returns `[{term_id, name, count}]` over current heads, with `coverage`.
- **K7 (`knowledgeStats`).** Returns:
  ```text
  {nodes_total, nodes_eligible, by_type:[{term,count}],
   chunks:[{embedding_profile,status,count}], vocabularies, terms, last_updated_at}
  ```
- **K8 (`answerFromKnowledge`).**
  - Request `{question, limit, filter}`; response `{answer, citations:[{node_id,revision_id,chunk_index}], coverage, mode}`.
  - It runs K1 internally, so only authorized, eligible chunks reach the model (R9). It returns `model_unavailable` when no model is configured.
  - It is a separate method because `answerChat` is session-grounded and `chat-v1.md` is still a draft.
- **K9 (`closeSession`).**
  - Request: `{session_name, reason, peer_name|null, operation_id}`.
  - Effect: `is_active` goes true → false, one way only. The close record goes to `sessions.internal_metadata.closed = {at, by_peer, reason, operation_id}`.
- **K10 (sessions).**
  - `listSessions` gains `is_active|null`, `member_peer_name|null` and `order:"name_asc"|"created_desc"`.
  - New: `listSessionMembers {session_name, after_name, limit}`.
- **K12 (display metadata).** It is display only; names stay immutable identities (DESIGN.md:369).

**Also required, owned elsewhere:**
- tonight's `expose-13` (the 13 methods);
- the R3 membership slice (`requester_peer_name` plus the grant `peers:[…]`);
- #29 wave 2 (`include_inactive`, and refusing to supersede into an inactive node).

---

## 6. v3 behaviour v4 deliberately does not carry

| v3 behaviour | Where in v3 | Why not |
|---|---|---|
| `oracle_mcp_call` / `oracle_mcp_list_tools`: spawn a caller-chosen command, args, env and cwd | `src/tools/mcp-in.ts:17-47`; `src/mcp/client.ts:41-137` [rep] | Remote command execution as the server user, over a remotely reachable bearer route. No action in the closed set can gate it (R8 adds none). v3 itself marked both non-remoteable (`mcp-rest-map.ts:95-96`), and in v4 every call is remote. AGENTS rule 7: fetched output is data, not tool authority. `mcp/tools.ts:8-11` lists powers that must never be MCP tools. v3 also marked `mcp_list_tools` `readOnly:true`, so it survived read-only mode. Bridging belongs in the client. |
| `oracle_trace_link` / `oracle_trace_unlink`: rewrite `prev`/`next` pointers without history | `trace/links.ts:24-69` [rep] | Traces are immutable. `prev_id` is written once at creation (use `prevTraceId`). A writable `next` edge breaks the rule of one source per edge (DESIGN.md:722, SPEC §14.4). Unlink is destructive (AGENTS rule 5, no revoke over MCP). The non-destructive substitute is a `correction` node with a `corrects` link to the trace. |
| `oracle_profile`: a hardcoded Thor profile [D5] | `oracles/registry.ts:4` [rep] | Not knowledge; no profile registry (AGENTS rule 4); 0 real calls. |
| Server-side ψ file I/O: `oracle_read(file)`, learn/handoff/trace markdown files, the inbox reading files, verify walking the disk | `read.ts:114-154`, `learn.ts:209-241`, `handoff.ts:114-125`, `learning-files.ts:30-75`, `verify/handler.ts:51-56` [rep] | LanceDB is canonical (AGENTS.md:24). A server-written vault file is a second writable source for one fact, path reads are a traversal surface (v3 D2), and the shared ψ vault is never written here (AGENTS rule 8). |
| `cwd`, or the server's own repo, deciding the project | `search/handler.ts:38`, `learn.ts:204-206`, `forum/handler.ts:25-28` [rep] | "cwd/adjacency does not prove ownership" (AGENTS.md:30). The server's repo is not the caller's project. |
| Heat ranking and usage bumps | `recap.ts:68-87`, `server/logging.ts:85-91` [rep] | "No popularity decay" (AGENTS.md:29); target19 has no such columns. |
| Hybrid 50/50 fusion, cross-encoder rerank, entity-link boosts, pointer index, acronym expansion | `search/handler.ts:35-118` [rep] | R7: keyword and semantic are separate, and fusing measured worse. The rest has no measured benefit; revisit under #7 (R16). |
| `nomic` / `qwen3` / `bge-m3` models (768/4096/1024 dimensions) | `search/definition.ts:47-51` [rep] | The embedding column is frozen at 384 (`search_chunks_v1.embedding` [src]). |
| Superseded documents staying in search | `supersede.ts:187` [rep] | The recall-eligibility rule (#29). History stays readable, so nothing is deleted. |
| `verify(check:false)` writing `_verified_orphan` | `verify/handler.ts` ≈167-185 [rep] | Invents a successor. |
| Stored thread status `answered` / `pending`; auto-answer (`oracle_response`); GitHub issue mirroring | `forum.ts:59,101-112`; `forum/types.ts:117-172` [rep] | Binary `is_active` (AGENTS.md:29). Reply state is derived. v3 never produced an answer or wrote any mirror field (D6). References are passive (rule 7). |
| Reopening a closed thread in place; numeric ids; offset paging | `forum.ts:163-180` [rep] | No reactivation (`context-ingestion-v1.md:31` [rep]); use a new session with a `continues` link. Ids are nanoid21/names and pages use keyset cursors. |
| Tenant taken from tool arguments; tool-group enable/disable messages | `mcp/tenant.ts:3`; `server.ts:200-203` [rep] | The route bank is authoritative. Visibility comes from grants, and unknown equals unpermitted (R8). |
| Mutable trace status (`raw`, `reviewed`, `distilling`, `distilled`) with `awakening` overwritten on re-distill | `trace/distill.ts` [rep] | The trace is immutable. `distilled` is derived from links. Each distill is a new node, and replacement is an explicit supersede. |
| `trace-<id>` concept, Thor/Stormforge auto tags | `distill.ts`, `research/note.ts` [rep] | A second authority for the edge; profile defaults. |

---

## 7. Dispatchable slices

**Rules for every slice:**
- One worktree per slice, branched from `v4/overnight-26sep`.
- Tests run on fresh `mktemp -d` datasets only, with a stub embedder and a stub model.
- Writes run as gated fixture children through `runGated` / `exec_with_gate` on fd 42, the same way the existing kernels do.
- Test file names match `test/mcp-*.test.ts`, so the `test:mcp` glob (`package.json:27` [src]) picks them up.
- Nat's style: one function per file, 350–500 lines per file at most.

**Ownership:**
- `knowledge/registry.ts` edits are serialized through a single owner (R7).
- Adapter tools own one file each under `mcp/legacy-v3/tools/`.

| Slice | Size | Depends on | Owns (creates or edits) |
|---|---|---|---|
| **VA** acceptance harness | S | – (first) | `test/fixtures/v3-compat-v1/sessions/v3-session-01.json`, `test/fixtures/v3-compat-v1/shapes/*.json` (v3 output key/type shapes with v3 file:line), `test/mcp-v3-acceptance.test.ts`, gated child `test/fixtures/v3-compat-v1/core/gated-session.ts`; the acceptor extends `.tmp/acceptor/live-probe` with `--v3` |
| **V0** frame | S | expose-13 merged | new `mcp/legacy-v3/{catalogue,dispatch,kb,compat-error,ids,guide}.ts`; edits `auth/service.ts` (derived action map, alias, `assertedPeer`), `mcp/index.ts` (one dispatch branch; factor out `callKnowledgeMethod`), `mcp/tools.ts` (catalogue append behind the flag, availability rule), `composition.ts` (flag), `app.ts` (the `X-Arra-Peer` header) |
| **K2** name lookups | S | – | `publication/taxonomy.parseLookupByName.ts`, reader facade wiring, a `taxonomy-write-v1.md` amendment (read section), registry entries |
| **V1** knowledge writes | M | V0, K2, expose-13 | `mcp/legacy-v3/tools/{oracle_learn,oracle_research_note,oracle_handoff}.ts`, `mcp/legacy-v3/{taxonomy,research-note-render}.ts` |
| **V2** knowledge reads | M | V0, #29 wave 2 | `tools/{oracle_read,oracle_supersede,oracle_reflect,oracle_list,oracle_stats,oracle_verify}.ts` |
| **V3** trace | M | V0, V1 (`taxonomy.ts`) | `tools/{oracle_trace,oracle_trace_get,oracle_trace_chain,oracle_trace_distill}.ts`, `mcp/legacy-v3/trace-hits.ts` |
| **K12a** session title | S | – | context parse/service for `registerSession` `h_metadata`, a `context-ingestion-v1.md` amendment |
| **V4** forum | M | V0, the R3 membership slice, expose-13; K12a recommended | `tools/{oracle_thread,oracle_threads,oracle_thread_read,oracle_thread_update}.ts`, `mcp/legacy-v3/speaker.ts` |
| **K1** chunk search | L | #30 wave 1 (FTS ngram) | owned by #30 wave 2, not by this doc; the adapter needs only the interface in §5 |
| **V5** search / ask / chain | M | V0, V1, K1 | `tools/{oracle_search,oracle_ask,oracle_search_chain}.ts`, `mcp/legacy-v3/extractive-answer.ts` |
| **K3+K4** listNodes filter and order | M | #29 wave 2 (same file) | `service.parseListNodes.ts`, `service.listNodes.ts`, a listNodes grammar amendment |
| **V6** list / inbox / recap | S | K3+K4 | `tools/{oracle_inbox,oracle_recap}.ts`; upgrades `oracle_list`, `oracle_reflect` |
| **K5** listTraces | M | expose-13 | `trace.parseListTraces.ts`, `service.listTraces.ts`, a `trace-v1.md` amendment |
| **V7** trace_list, chain forward | S | K5 | `tools/oracle_trace_list.ts`; upgrades `oracle_trace_chain`, `oracle_trace_get` |
| **K6+K7** term usage, stats | M | – | `taxonomy.parseListTerms*.ts`, `service.listTerms.ts`, `service.listTermUsage.ts`, `service.knowledgeStats.ts` |
| **V8** concepts, stats | S | K6+K7 | `tools/oracle_concepts.ts`; upgrades `oracle_stats` |
| **K8** answerFromKnowledge | L | K1, the R9 provider | `publication/service.answerFromKnowledge.ts`, a `chat-v1.md` sibling amendment |
| **V9** ask with llm | S | K8, V5 | upgrades `oracle_ask` |
| **K9–K11** | M | ruling D7 (K9 only) | context service and parse files, a `context-ingestion-v1.md` amendment |
| **V10** forum parity | S | K9–K11 | upgrades the four forum tools and `oracle_inbox kind:all` |

### Failing-first tests per slice

Each test below is written before its slice's code, seen red, then turned green.

**V0** (`test/mcp-v3-frame.test.ts`):
1. With the flag off, no `oracle_*` tool is listed.
2. A grant of `content:read` only lists only read-family tools. `oracle_mcp_call`, `oracle_mcp_list_tools`, `oracle_trace_link`, `oracle_trace_unlink` and `oracle_profile` are never listed; calling one returns 403, byte-identical to an unknown tool.
3. A catalogue entry whose `requires` names a method missing from the registry is not listed. Calling it with the action held returns `not_yet_available`.
4. With the dataset root unset, the family is not listed.
5. `arra_search` dispatches as `oracle_search` under `oracle_search`'s action and is not listed. `muninn_search` is unknown.
6. Each of `tenantId`, `tenant_id`, `tenant`, `orgId`, `org_id`, `workspace_name`, `bank` returns `isError`.
7. A table-driven check over the catalogue: every tool's action equals the service map, and every `uses` method's action is at or below the tool's action. Mutating one entry must fail this test.
8. `kb()` refuses a method outside `uses`, and refuses a write method from a read tool.
9. A `CompatError` crosses `runMcp` as exact JSON with `isError`, and the audit row says `error`.
10. `X-Arra-Peer: nat` against a grant with `peers:["neo"]` is refused. With no header, `assertedPeer` is null.
11. `____IMPORTANT` mentions "not carried" and "excluded from recall".

**K2** (`test/taxonomy-lookup-service.test.ts` plus a transport case):
- by-name hit;
- miss returns null;
- another workspace's row returns null (isolation);
- closed keys and name grammar;
- reachable over HTTP and MCP under `content:read`.

**V1** (`test/mcp-v3-writes.test.ts` plus a gated child):
1. `oracle_learn` on a fresh workspace publishes a node with type `learning`, the concept and project terms, body equal to the pattern, and a title of at most 80 characters. Chunks are `pending`. The response keys include the v3 shape, and `id` = node_id.
2. `oracle_learn` works on a workspace **seeded with other reserved ids**. This is the test that proves K2 is needed.
3. A concept in a sealed vocabulary returns `isError` naming the concept, and the node count is unchanged.
4. An unknown required vocabulary returns `semantic_refusal`.
5. A fake `indexRevisionChunks` failure gives `success` with `embedding:"failed"`, and `reconcileSearchChunks` then lists the revision as missing.
6. A research note URL becomes a `url` link with `supports`/`locator_only`; `repo`+`issue` becomes an `issue` link with `discusses` and a url. There are no `thor-oracle`/`stormforge` tags, and a warning is present.
7. A handoff becomes type `note` with `concepts:handoff` and `memory_horizon:short_term`. The author is the bound `X-Arra-Peer`, null without one, and never the principal.
8. The temporary cwd and HOME are unchanged afterwards (no ψ write).
9. Content over 256 KiB returns `limit_exceeded`.

**V2** (`test/mcp-v3-reads.test.ts`):
- **read:**
  - `read(id)` round-trips the body.
  - `read(file)` returns `not_carried`; a UUID returns `legacy_id_unknown`.
  - A crafted id that is both a direct nanoid21 node and a derived legacy node returns an error.
- **supersede:**
  - The v3 shape comes back; the same call again gives `unchanged:true`.
  - A different successor gives "already superseded by X".
  - Superseding into a superseded target is refused (R7).
  - With no reason, the default reason is recorded.
  - `read(old)` shows `superseded_by`, and `reflect` never returns the old node.
- **list:** has an `order_changed` warning; `type:pattern` is filtered after the page.
- **stats:** `total_documents` equals the number of publishes; `partial` is set.
- **verify:** one failed index gives `missing:1`; `check:false` returns `not_carried`.

**V3** (`test/mcp-v3-trace.test.ts`):
1. A real-shaped `oracle_trace` (ψ `foundFiles`, a 40-hex commit, an issue) writes commit and issue hits only. Files go to `h_metadata.legacy`. `summary` equals v3's counts.
2. A parent gives depth 1. An unknown parent returns `isError` "Parent trace not found".
3. A short hash goes to `unrepresentable_commits`.
4. `idempotency_key` replays with the same `trace_id`.
5. `trace_get` round-trips all `found_*` arrays. After distill it gives `distilled_to_ids`. A UUID returns `legacy_id_unknown`.
6. The chain walks back. A fork gives `forked:true`. Forward is `unavailable`.
7. Distill:
   - promoted → `learning` with a `derived_from` trace link;
   - not promoted → `conclusion`;
   - re-distill creates a second node, and the trace row bytes are unchanged.

**V4** (`test/mcp-v3-forum.test.ts`):
1. No speaker returns `speaker_required`.
2. A new thread registers the session, registers and joins the speaker, and appends one message. `thread_id` is a string. A retry with the same `idempotency_key` does not duplicate.
3. A speaker who is not a member gets an error, with no silent join; `join:true` joins.
4. `thread_read` returns messages in seq order with `author` = peer. A non-member reader is refused (R3). The read cursor is unchanged.
5. `threadId:42` returns `legacy_id_unknown`.
6. `thread_update` with `answered` returns `semantic_refusal`. A missing thread returns an error, not success. `closed` returns `not_yet_available`.
7. Reopen on a fixture-closed session creates a new session, and `listSessionLinks` shows `continues`.

**V5** (`test/mcp-v3-search.test.ts`):
- learn, index, search: the keyword search finds the node.
- `oracle_search "ลืม"` finds a learning containing "หลงลืม" (R14 inside-word).
- A 2-code-point query gives `metadata.match:"substring_scan"`.
- A superseded node is absent from results but readable by id.
- `project` P returns P and `_universal`, not Q.
- `mode:"hybrid"` gives `mode_effective:"fts"` and a warning; `model:"bge-m3"` gives a warning.
- Semantic search before backfill gives a warning, not an error.
- `ask llm:false` returns citations; `llm:true` with no model returns extractive plus a warning.
- `search_chain` creates N traces linked by `prev_id`; a read-only principal gets 403.

**V6–V10:**
- **V6:** the inbox is newest first; recap is markdown within budget; list is newest first with `total` exact.
- **V7:** `trace_list` with `query`; chain forward and fork handling.
- **V8:** concept counts match the published terms; `stats.by_type` is correct.
- **V9:** a stub model receives only eligible, authorized chunks. Assert the prompt excludes a superseded node and an other-workspace node.
- **V10:** close then refuse append; threads filtered by member; tail read of the last N.

**K slices:**
- Each carries its own `<kernel>-service` / `-ownership` / `-precision` lanes in the existing naming (TEST-SPLIT.md) and a transport reachability case.
- The isolation rule is always tested: a row in workspace A is invisible from B.

---

## 8. Acceptance: a v3 client session works against v4

**What counts as passing.** One ordered script of real-shaped v3 calls:
- The inputs are modelled on the sampled real calls [run]; the content is anonymized.
- It runs against v4 over `POST /mcp/:bank` with a bearer from a 0600 policy file on a fresh mktemp dataset.
- **A step passes** when:
  - the response is not `isError` (or is the documented `arra-v3-compat/1` refusal for that step);
  - its key set and JSON types match the v3 shape fixture for that tool;
  - every deviation is named in `compat_warnings`.
- **A step whose tool is not yet advertised is `GAP`, never `PASS`.**

**Principals:**
- `rw`: content:read, content:write and diagnostics:read on `bank-a`, with `peers:["neo"]`.
- `ro`: content:read on `bank-a`.
- `other`: all actions on `bank-b`.

**Script** (`v3-session-01.json`; the slice that turns each step green is in brackets):

1. `initialize`, then `tools/list` as `rw`: exactly the advertised v3 set plus the v4 tools. None of the 5 not-carried names. [V0]
2. `____IMPORTANT {}` returns the v4 guide. [V0]
3. `oracle_learn {pattern:"APFS snapshots: tmutil localsnapshot before disk surgery", concepts:["apfs","backup"], project:"github.com/laris-co/homelab"}` returns `success`, a nanoid21 `id` and `embedding:"enqueued"`. [V1]
4. `oracle_learn {pattern:"หลงลืม: forgetting is binary is_active", concepts:["thai"]}`. [V1]
5. `oracle_read {id:<3>}`: `content` equals the pattern. [V2]
6. `oracle_list {type:"learning", limit:30}` includes steps 3 and 4. [V2; V6 for order]
7. `oracle_search {query:"APFS snapshot tmutil disk management", limit:5}` returns step 3 first. [V5]
8. `oracle_search {query:"ลืม", mode:"hybrid", limit:8}` returns step 4, with `mode_effective:"fts"`. [V5]
9. `oracle_learn` a replacement, then `oracle_supersede {oldId:<3>, newId:<9a>, reason:"updated"}`: `success`. A repeat returns `unchanged:true`. [V2]
10. `oracle_search` as in step 7 no longer returns `<3>`. `oracle_read {id:<3>}` shows `superseded_by`. [V5, V2]
11. `oracle_trace {query:"black.local setup openclaw", project:"github.com/laris-co/homelab", queryType:"project", agentCount:5, foundFiles:[{path:"ansible/openclaw-black.yml", type:"other", confidence:"high", matchReason:"playbook"}], foundCommits:[{hash:<40hex>, shortHash:"abc1234", date:"2026-02-23", message:"fix"}], foundIssues:[{number:42, title:"t", state:"open", url:"https://github.com/laris-co/homelab/issues/42"}]}` returns `trace_id`, `depth 0` and `summary {1,1,1,3}`. [V3]
12. `oracle_trace {query:"follow-up", parentTraceId:<11>}` returns `depth 1`. [V3]
13. `oracle_trace_get {traceId:<11>, includeChain:true}`: all `found_*` arrays round-trip; `child_trace_ids` is null with a warning (full after V7). [V3]
14. `oracle_trace_list {query:"openclaw", limit:20}` includes step 11. [V7]
15. `oracle_trace_distill {traceId:<11>, awakening:"…", promoteToLearning:true}` returns `learningId`. Then `oracle_search` finds it. [V3, V5]
16. `oracle_handoff {content:"# Handoff: …", slug:"fleet-teardown"}` returns `id`. [V1]
17. `oracle_inbox {}`: the first file is step 16. [V6]
18. `oracle_thread {message:"Birth thread for …", title:"birth"}` (with `X-Arra-Peer: neo`) returns a string `thread_id`. [V4]
19. `oracle_thread {threadId:<18>, message:"## Lesson: …"}`, then `oracle_thread_read {threadId:<18>}` returns 2 messages in order. `oracle_threads {limit:20}` includes step 18. [V4]
20. `oracle_thread_update {threadId:<18>, status:"answered"}` returns `semantic_refusal`, the documented refusal. [V4]
21. `oracle_stats {}`: `total_documents` ≥ 5. [V2 partial, V8 full]
22. `arra_search {query:"APFS", limit:5}` equals step 7's result set. [V0+V5]
23. `oracle_trace_get {traceId:"3264052e-e8d4-4a64-a255-8e72b0e0979b"}` and `oracle_thread_read {threadId:42}` both return `legacy_id_unknown`. [V3, V4]
24. `oracle_search {query:"x", tenantId:"t"}` returns `isError` `unsupported_argument`. [V0]
25. As `ro`: `tools/list` has no write tools. `oracle_learn` returns 403, identical to `oracle_nope`. [V0]
26. As `other` on `bank-b`: `oracle_read {id:<3>}` returns not found, and `oracle_search` returns nothing from `bank-a`. [V2, V5]
27. `oracle_mcp_call {command:"sh", args:["-c","id"], toolName:"x"}` returns 403 (unknown), and no process is spawned. The test injects a `Bun.spawn` spy. [V0]

**Where it runs:**
- **In process:** `test/mcp-v3-acceptance.test.ts` runs as a gated child. It builds the service with `createOperationService` + `configureKnowledgeAccess` + `createMcpAdapter`, modelled on `.tmp/understand/kb-mcp-probe.ts` [rep].
- **Live:** the Codex acceptor's `run.sh <checkout> <label> --v3` runs the same JSON against a live dev server.
- **Optional, needs Nat's OK:** a real Claude Code smoke. A scratch `.mcp.json` with the http `arra-oracle` entry points at a dev server on mktemp data. Run `claude -p "save X with oracle_learn, then find it with oracle_search"`, and confirm both calls in `call_log` with `status:"ok"`.

**Scoreboard metric.** Coverage is the share of the 709 real calls whose tool's steps all pass:

| After | Coverage |
|---|---|
| V0–V4 | ≥ 52% (371 of 709) |
| V5 | ≥ 97% |
| V6–V10 | 100% minus deliberate refusals (the 2 `answered` updates, each answered with `arra-v3-compat/1`) |

---

## 9. Decisions for Nat

- **D1 Legacy node id derivation.** `sha256("arra-legacy-node/v1\n"+ws+"\n"+id)[..21]`, shared byte-for-byte with #34, plus the rule that when both a direct and a derived node exist, the call is refused.
- **D2 Adapter vocabulary names.** `concepts`, `legacy_type`, `project` (with `_universal`). #34 must create the same ones from legacy tags (R11/R17).
- **D3 Superseded policy.** Recall excludes superseded nodes; browse includes them. This is a visible change from v3 P-001 for `oracle_search`.
- **D4 Types.** Research notes: `learning` (parity) or `conclusion`. Distill with `promoteToLearning:false`: `conclusion` (R10).
- **D5 `oracle_profile`.** Drop it (recommended; 0 calls) or serve it as static data.
- **D6 `arra_*` inbound aliases.** 29 historical calls, the last on 2026-05-18. Recommended: resolve inbound, never list.
- **D7 `closeSession`.** Whether a session can be closed, one way, with the record in `sessions.internal_metadata`. Otherwise `oracle_thread_update(closed)` stays `not_yet_available`.
- **D8 Speaker header.** `X-Arra-Peer` as the connection-level speaker assertion, bound by R3 `peers:[…]`.
- **D9 v3 corpus import.** Out of scope (AGENTS rule 3). The consequence is that v3 ids never resolve in v4. Say so if an explicit, on-a-copy v3 import is wanted later.
- **D10 Family flag default.** `ARRA_MCP_V3_COMPAT` off until VA is green, then on.
- **D11 Linking two existing traces.** Keep it not carried. Carrying it would need an append-only edge record and would reopen SPEC §14.4.

---

## 10. Defects found on the way (outside the adapter)

1. **The knowledge report's "31 built-ins" is 30** (`mcp-manifest.ts:53-76` [src]).
2. **R17 names a column that does not exist.** It sends `distilled_at` to "the trace link's `internal_metadata`", but `revision_links` has no such column; its columns end at `capture_status, note` (`publication/storage.ts` `TARGET_SCHEMA` [src]). It probably means `node_revisions.internal_metadata`; the ruling should say so.
3. **Migrated traces would be unreadable.** The rehearsal writes `status:"raw"` and ids like `"trace-01"`, and the TS reader refuses both as `integrity_failure`. The rehearsal also writes a hit of kind `"file"`, which is not in `TARGET_KINDS` [rep, trace §3.1; `TRACE_STATUSES = open|complete|abandoned` verified in `publication/trace.types.ts:6` [src]]. #34 must map them.
4. **`createTrace` accepts any `depth`** [rep], and `UNIQUE(name, W)` from SPEC is not enforced (K13).
5. **`kb_*` tools are advertised even when no dataset is configured** (`mcp/tools.ts:118-133` [src]). This breaks #31's "not advertised as live" rule; the V0 availability rule fixes it for the v3 family only.
6. **A dead duplicate action map** sits at `mcp/index.ts:22-34` [src], with no `kb_` entries and no callers [rep]. It should be removed before V0 adds a third map by mistake.
7. **v3 defects not to port:**
   - forum D1–D10 (for example, `thread_update` reporting success on a missing thread, and handoff writing where inbox never reads);
   - `oracle_mcp_list_tools` marked `readOnly:true` while it spawns processes.

---

**Key files for the implementer:**
- `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-overnight-26sep-sat2026/app/server/src/knowledge/registry.ts`
- `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-overnight-26sep-sat2026/app/server/src/auth/service.ts` (lines 110-143, 350-532)
- `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-overnight-26sep-sat2026/app/server/src/mcp/index.ts`
- `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-overnight-26sep-sat2026/app/server/src/mcp/tools.ts`
- `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-overnight-26sep-sat2026/app/server/src/publication/storage.ts` (`TARGET_SCHEMA`)
- `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/wt/arra-oracle-v4-overnight-26sep-sat2026/docs/overnight/DECISIONS.md`
- `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v3/src/tools/mcp-manifest.ts`
- `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v3/src/config/tool-groups-core.ts`
