# Authorization integration v1 — working draft

Status: **APPROVED DESIGN FOR BOUNDED LOCAL INTEGRATION; EXPLICIT FILE-OWNERSHIP DISPATCH STILL REQUIRED**. Owner v4-codex (AI). Independent review conditionally approved normative draft `5f543341b046240ee3f2c4aabb77bedbbb5e1807edfc0658e181d714b58f9141`; installed-version parsing probes below satisfy its remaining SDK prerequisite. This follows the isolated `authorization-v1.md` section7 policy slice. #25 stays open until integration is implemented and independently verified. No live credentials, runtime restart or deployment are authorized.

## 1. Exact request classes

| Surface | Scope source | Required action | Permitted work after admission |
|---|---|---|---|
| GET /health | none | public constant liveness | constant version/auth-mode only, zero storage/model/policy I/O |
| Static UI assets | none | public asset | no embedded token, policy or tenant data |
| GET /api/health | query bank | diagnostics:read | scoped counts and safe model readiness, no storage URI/model address |
| GET /api/memories | query bank | content:read | scoped list |
| POST /api/memories | body workspace_name | content:write | scoped insert; reject query bank if present and different |
| GET /api/search | query bank | content:read | scoped lexical/vector search |
| POST /api/backfill | global | maintenance:backfill | existing global backfill, explicitly global |
| POST /api/reindex | global | maintenance:reindex | global index maintenance |
| MCP remember | route bank | content:write | forced route scope, reject conflicting args workspace/bank carriers |
| MCP recall/get_memory/list_memories | route bank | content:read | existing scoped reads |
| MCP call_log/call_stats | route bank | audit:read | scoped audit reads |
| MCP bank_info/status | route bank | diagnostics:read | sanitized diagnostics, never global path/endpoint or other-bank counts |

Unknown actions and unknown methods never bypass the gate. Global endpoints reject a supplied bank parameter rather than implying that a bank scopes a global action. Source clients must stop adding bank to these requests; their warnings remain explanatory, not the enforcement mechanism.

For every MCP request, load one snapshot and sample one now_ms, then call admit in fixed order content:read, content:write, audit:read, diagnostics:read for the exact route workspace. All unauthenticated results mean HTTP 401; zero successes with authenticated forbidden results mean HTTP 403; any mixed credential-validity result or unexpected invalid_request/policy_invalid result fails closed as fixed HTTP 503 policy-unavailable. Keep successful Admissions internal. Initialize/ping/notifications require at least one success; tools/list preserves catalogue order and includes only tools mapped to successful actions. Known tools/call uses only its matching action Admission. No policy, digest, complete grant list or failure detail is returned. A global-maintenance-only principal has no workspace discovery permission. Invalid credentials deny before RPC parsing/tool dispatch/audit. Unknown tools do not echo attacker-controlled content in authentication errors. Unknown legacy /mcp/:bank/:workspace remains explicitly rejected and never executes a tool.

## 2. Loader and admission lifecycle

Configuration: `ARRA_AUTH_POLICY` is an explicit absolute path to the local policy file; no repository search or embedded default. `ARRA_ORIGIN` declares one exact scheme/authority for this process, initially `http://127.0.0.1:<PORT>`. Default listener remains loopback; remote/TLS/proxy deployment is a separate gate. No anonymous fallback or environment boolean bypass exists.

Validate startup configuration and policy BEFORE startup index creation or listening. Factory construction in tests takes explicit configuration and injected scratch dependencies; importing modules does not start servers, read real policy files, or open data/model connections.

For each protected request, open the configured absolute path once with no-follow semantics using a supported POSIX API. Validate regular-file/current-UID/no group-or-other bits using fstat on that same descriptor; read at most 262145 bytes from that descriptor, reject byte 262145, close it, then call parsePolicy. Never validate one pathname/inode and reopen another. Parent-directory trust is an explicit operator TCB prerequisite. The snapshot linearizes at successful file open: an open before atomic rename may use the old inode; an open after rename must use the replacement. No cache or last-good fallback. Unsupported same-descriptor/no-follow behavior blocks loader readiness rather than weakening it. Startup uses this same loader before index work/listen, not as a request cache. Scratch tests cover rename revocation, expiry, deletion, malformed UTF-8, oversized input, symlink/nonregular files and wrong permissions.

Caller identity derives only from a single Bearer header validated by the pure module. Trusted current milliseconds are sampled once per protected request after loading policy. Missing/invalid credentials -> 401; insufficient exact grant -> 403; unavailable/invalid policy -> 503; malformed/conflicting request scope -> 400. Error bodies are fixed small JSON, never tokens, IDs of inaccessible objects, parser excerpts or paths. All protected responses, success and failure, send Cache-Control: no-store. 401 includes a fixed Bearer challenge with no secret. Fixed ordering: classify public/protected route; enforce Host (400) then present Origin (403) on all routes before policy I/O. On protected routes, repeated/ambiguous Authorization yields generic 401, using the pinned strict-header rejection profile below. Resolve only the minimum scope carrier required by admit: malformed/missing/conflicting workspace or a bank parameter on a global endpoint yields 400 before policy. Then load/parse policy (503), sample time, and admit (401/403). Only after admission validate non-scope payload and dispatch. MCP performs the four-action projection before JSON-RPC parsing; unknown method/tool errors occur only after successful workspace discovery. This deliberately gives policy failure precedence over credential failure after valid scope/transport. No rejected request reaches storage/model/tenant audit. POST /api/memories is the only protected route whose scope is in JSON. Its route-local parser must precede and disable default framework body decoding. Accept application/json with optional UTF-8 charset only; reject unsupported content type with fixed 415, and any Content-Encoding other than absent or identity with fixed 415. Stream at most 262145 raw bytes; byte 262145 means fixed 413, independent of Content-Length. Fatal-decode UTF-8, then strict-parse one JSON object (depth <=64), rejecting duplicate decoded keys and lone surrogates. Missing/non-string/blank/over-256-UTF8-byte workspace_name, malformed JSON/UTF-8, or conflicting query bank returns fixed 400 before policy I/O. A single identical query bank is tolerated but never authoritative; repeated scope parameters are ambiguous and reject. Copy the exact workspace and retain only the bounded parsed payload needed after admission; discard parser internals. No store/model/audit work occurs during scope parsing. After load/admit, validate remaining fields. If installed Elysia cannot demonstrate that this custom parser runs before default decoding, this route blocks dispatch rather than accepting an unbounded pre-auth parse. Other protected POST bodies, including MCP, are read only after route-scope admission, with the same 256-KiB raw cap, depth and encoding rules; do not let default decoding silently run before the gate. Public liveness/assets skip policy admission, not Host/Origin checks.

## 3. Shared service context and no accidental bypass

The private integration factory accepts an Admission only in the same unexported call frame that invoked admit, then creates a module-private WeakMap-backed frozen handle containing only principal_id, credential_id, policy_version and one copied target/action. It never retains Request, headers, Authorization, body, token, digest or Policy. No exported function accepts an Admission/context supplied by callers. Exposed service methods validate provenance and expected target/action before calling stores. Never trust a structural TypeScript assertion, user-supplied principal, body auth context, peer name or User-Agent. A forged context and a read context passed to a write/global method must fail before storage/model access.

The composition graph is fixed: retain auth/policy.ts; auth/loader.ts owns same-descriptor policy I/O only; auth/service.ts owns policy loading/admission orchestration, the four-action MCP projection, private WeakMap contexts and the protected operation facade. createApp(config, facade) receives the facade, not raw data/model/audit dependencies. A separate startup composition module supplies internal dependencies to the facade. HTTP index/app and MCP request adapters import neither db, embed, storage nor mcp/calls and receive no raw store handles. Raw helpers may remain internal/test exports, never alternate request services. The raw MCP runTool/body+bank dispatcher is no longer a runtime export; its adapter receives the admitted operation facade. Module import performs no config/file/store/model/listen work. import.meta.main triggers startup configuration/policy validation, then trusted index work, then listen. The composition module is not an HTTP/MCP adapter and has no anonymous operation API. Static dependency/runtime-export checks and direct-call denied-operation tests cover this graph; neither test alone establishes universal code isolation.

HTTP and MCP adapters use the same operation service methods. CLI/browser call these transports; they cannot create contexts. Exported dispatch handlers must no longer accept only body+bank and operate without admission. Raw dataset helpers are internal implementation/test tools, not alternate request-facing services. Existing raw table exports must have no request path around service admission; removing an export alone does not prove this. Existing scoped reads remain defense in depth; insert rejects missing/blank/non-string scope instead of inventing `default`.

An authenticated request naming workspace A may not cause a reference read/write in B. Future #26–#34 services reuse this boundary and require their own reference validation. Pure in-process helpers cannot defend against malicious code with direct filesystem access; that is outside the application threat boundary.

## 4. Audit attribution and failure boundary

Audit append is an internal consequence of an admitted tool operation, never an API or user grant. Derive workspace/principal/credential from the context, not tool args. Preserve `peer_name` as null-or-registered peer; principal never populates it. The active15 mapping uses a fresh wrapper-owned h_metadata object exactly `{input:<redacted/truncated>,result:<redacted/truncated>,auth:{principal_id,credential_id,policy_version}}`; never merge caller metadata. Credential ID is intentionally visible only to audit:read callers. `internal_metadata.transport.user_agent` stays separate. Do not change physical schema for this integration. Transport User-Agent remains transport metadata.

Authentication failures do not write into attacker-chosen workspace audit rows. Only tool calls admitted for their exact action may append scoped rows, including subsequent payload/tool execution failures; discovery/authentication/permission denials never append tenant rows; no raw Authorization header enters that path. Store payloads/errors remain subject to existing fixture-limited redaction; authentication secrets themselves must never enter logging inputs. Audit persistence failure is not magically transactional with the operation: define and test the existing best-effort behavior explicitly and emit only a fixed sanitized audit-failure code/count, never raw exception text. It does not roll back the operation. Strong durable auditing requires a separate persistence contract.

## 5. Browser, CLI and raw transport constraints

CLI v1 secret source is ARRA_TOKEN only. No raw token flag, URL credentials, automatic config lookup or token printing. For protected commands, validate exactly 64 lowercase hex characters before network, set exactly one Authorization: Bearer <token>, and use redirect: 'error'. Plain HTTP with a bearer is permitted only for literal 127.0.0.1 or [::1], not localhost or arbitrary DNS; HTTPS remote deployment remains a separate gate. Public health sends no Authorization and requires no token. Backfill/reindex requests contain no bank parameter. Tests capture outbound headers with synthetic credentials, exercise redirect refusal, and check errors/output for literal-secret absence.

Browser: explicit token input retained only in page memory. Protected calls use relative same-origin URLs and one shared fetch wrapper reading that variable at call time, setting exactly Authorization: Bearer <token>, redirect: 'error', and cache: 'no-store'. No Authorization on public /health or asset requests. No localStorage/sessionStorage/cookie, URL, static asset or console storage. Do not register/use a service worker or Cache API for protected data. Logout clears the JS variable and input value. Never infer scopes from UI labels. API 401/403 show a generic access error. Browser auth does not make a malicious extension or same-origin XSS safe; no such claim.

All requests must pass an exact configured Host authority check; present Origin must exactly match configured origin and cannot be `null`, comma-joined or repeated. Origin absence is valid for CLI/MCP. No reflected CORS or trust in forwarded headers. Supported ingress is pinned Bun 1.3.14 HTTP/1.1 with Elysia 1.4.30. These expose Fetch Request headers after comma-joining duplicates, not raw header-line counts. Keep the existing ingress; enforce exact Host/Origin and strict Bearer grammar rejecting commas on the resulting values. This rejects the measured duplicate identical/distinct/empty/OWS/case variants, but is explicitly a post-flattening fail-closed grammar gate, NOT a raw-line multiplicity proof. A single comma-bearing value is rejected too. Accept no alternate auth scheme with comma-bearing grammar. Startup must refuse an unsupported Bun transport version until its raw-wire regression matrix is reviewed; do not merely warn and continue. Earlier proxies or HTTP/2/3 are not supported by this evidence; production proxy/remote deployment remains separately unapproved. Any future requirement to preserve literal field-line counts must use a reviewed raw ingress (e.g. node:http rawHeaders), not an invented Elysia hook.

## 6. Required integration evidence

- Every surface in section1 mapped to shared service admission, including MCP discovery/status and global maintenance.
- Raw socket tests for repeated/malformed Authorization/Host/Origin, conflicting scopes and DNS-rebinding-style Host mismatch; tests use an ephemeral loopback server and synthetic policy only.
- Two-bank credentials exercise objects, search, stats, audit, writes and global operations; negative calls prove zero storage/model/mutation effects. Tests distinguish scoped data denial from public liveness.
- Policy replacement/revocation/expiry tests on real temporary files; malformed/missing policy denies, never last-good fallback.
- Direct exported handler/service calls cannot bypass admission; forged/wrong-action contexts rejected; attribution changes do not widen permission.
- CLI/browser credential presence and absence per command, redirect refusal, protected success/error cache headers, logout memory/input clearing and no token in output/errors/persistent DOM storage; literal-secret absence checks on logs/audit/output use synthetic tokens only.
- Raw body tests: chunked/no Content-Length, misleading declared lengths as handled by the pinned parser, exact cap/+1, compression, duplicate decoded keys, invalid UTF-8, malformed JSON and depth. An oversized or denied body performs no store/model/audit work. Parsing error behavior must distinguish framework rejection from application rejection rather than crediting a test that never reaches its intended gate.
- Composition tests enumerate adapter imports/runtime exports, prove raw handlers cannot be called without service admission, and verify public liveness does not load policy or invoke stores/models.
- Existing Python/Bun/CLI contract suites, strict TypeScript/build, changed-file lint/static checks and source/golden baseline protection.
- Runtime integration may be implemented locally without activating the currently running service. #25 acceptance must state whether restart/production activation remains unperformed.

## 7. Decisions pending review

The bounded body protocol, composition boundary and same-origin client handling above received conditional independent approval. The installed-version probe below demonstrates route-local decoder bypass and incremental raw reads. The API constraint is now frozen: set route option `parse: "none"` on protected POST routes, do not attach a default body-schema decoder that reintroduces pre-admission parsing, and use the untouched `request.body` stream. Header-only guards run before reading. For POST memories, bounded strict parsing extracts scope before the facade admits; for MCP/global POSTs, facade admission precedes body reading. A module/import/export choice that violates section3 must be escalated, not replaced by a transport-only gate. This is design readiness only: bounded implementation dispatch and all section6 tests remain mandatory; no #25 closure follows.

## 8. Transport and loader evidence (2026-09-20)

Read-only researcher probes on installed Bun 1.3.14 / Elysia 1.4.30 used ephemeral loopback HTTP/1.1 only, with no app/model/dataset access. Duplicated Authorization/Host/Origin values, including one empty value, both empty, repeated identical values and casing/OWS variants, produced comma-bearing Fetch values; none became a valid single value. Single comma-bearing fields are indistinguishable from duplicates after flattening. This justifies the restricted grammar rejection profile above, not a universal raw-header detector.

Official API context: [Bun server](https://bun.sh/docs/runtime/http/server), [Elysia lifecycle](https://elysiajs.com/essential/life-cycle), [Fetch Headers combining](https://fetch.spec.whatwg.org/#headers-class). [Bun node:http rawHeaders](https://bun.sh/reference/node/http/IncomingMessage/rawHeaders) is a distinct ingress alternative, not a property of Elysia Request. [RFC 9112 Host requirement](https://datatracker.ietf.org/doc/html/rfc9112#section-3.2) remains the intended rejection behavior.

Scratch POSIX loader probe also executed node:fs openSync with O_RDONLY|O_NOFOLLOW, fstatSync on that descriptor, bounded readSync and closeSync; opening a symlink failed ELOOP. Implementation must check the same descriptor, cap+1, regular file/current owner/mode, and close on every path. No claim of a filesystem sandbox or safety against a malicious trusted operator follows.


### Body-decoder ordering probe

On the same installed Bun/Elysia versions, a route configured with `parse: "none"` exposed `request.bodyUsed === false` in route-local beforeHandle and again in the handler before its reader started. A rejected synthetic authorization path never invoked the handler; gzip was rejected before a raw read. Invalid UTF-8 and duplicate-key JSON arrived as original bytes, not framework-decoded values. [Elysia lifecycle documentation](https://elysiajs.com/essential/life-cycle) explicitly documents skipping the parser with this option; installed compose.mjs selects no automatic body parsing for it.

An 8-byte scratch limit accepted exactly 8 and rejected 9 for chunked requests without Content-Length. A separate partial-wire request sent one 9-byte chunk without a terminating chunk: the reader yielded it, cancellation succeeded and 413 returned without waiting for the whole message. These small probes prove ordering and incremental-read viability, not the application's required 262144/262145 boundary tests. Keep accumulated accepted chunks bounded by the route cap and cancel on overflow. One runtime-delivered chunk may transiently exceed that cap; do not claim a hard process-memory sandbox.

Bun's global maxRequestBodySize can reject declared-length overflow before the handler and can override a handler response when a chunked read exceeds its limit. Do not rely on that backstop as proof of the route's fixed error behavior. Set the global backstop explicitly to 1 MiB, above the route cap; raw application reads must still stop/cancel at the 256-KiB route cap. Tests must use that configured backstop rather than assume a runtime default. Traffic exceeding the global backstop may receive a framework-generated rejection rather than the application's small JSON envelope; this is a resource ceiling, not an admission path. Tests distinguish those cases. [Bun Serve options](https://bun.sh/reference/bun/Serve).

## Amendment 2026-09-26 (overnight R14 (+ R7 tokenizer))

This section amends §1's `GET /api/search` and `MCP recall` rows and §2's "trusted index work". The text above is left as written. Authority: `docs/overnight/DECISIONS.md` R14, and R7 as amended at 21:40 (one shared ngram configuration for every lexical index). Issue #10.

**What changed.**

- Lexical search (`GET /api/search` with `mode=text`, and MCP `recall` in text mode) is a substring contract. Every row returned contains the query, compared case-insensitively.
  - For a query of 3 or more code points, the index is character trigrams, `ngram(3,3)` with `prefixOnly:false, stem:false, removeStopWords:false` (`app/server/src/fts/fts.constants.ts`). Candidates are overfetched and each is re-checked as a literal substring before it is returned. The overfetch doubles while too few verify, up to a fixed ceiling of 4096 candidates.
  - For a query under 3 code points, which a trigram index cannot look up, the server runs a bounded scan inside the same scope predicate: `content ILIKE '%q%' ESCAPE '\'`, with `%`, `_` and `\` escaped and `'` doubled.
  - The query reaches LanceDB as a `MatchQuery`, never as a bare string. A double-quoted bare string was parsed as a phrase query and threw on the position-less index (measured on the pre-amendment code).
- Both transports now answer text search with the same object: `{mode, match, count, rows}`. `match` is `"ngram"` or `"substring_scan"`. Vector mode answers `{mode, count, rows}` and has no `match`.
  - **Breaking for MCP clients:** `recall` previously returned a bare array of rows; it now returns the object above in both modes.
  - A `substring_scan` row has no `score`; none is invented.
- Trusted startup index work previously created the content index only when none existed. It now reads the live `indexDetails` of every FTS index on `memories.content`.
  - An index whose `base_tokenizer`, `min_ngram_length`, `max_ngram_length`, `prefix_only`, `stem` and `remove_stop_words` already match is kept: no write, no new table version.
  - A mismatching one, such as the `icu` index earlier builds created, is rebuilt once with `replace:true` under its own name.
  - Any second FTS index on the column is dropped.
  - This still runs before listen, as operator work, never on a request path. `POST /api/reindex` (`maintenance:reindex`) still rebuilds unconditionally.

**Unchanged.** Admission, action (`content:read`), scope carrier, error bodies and ordering. Both the scan and the index lookup run inside the same `workspace_name` predicate.

**Why.** `icu` segments whole Thai words and cannot find a sub-word query: `ลืม` against a stored `หลงลืม` returned nothing (0/2 inside-word probes, #10). `ngram(3,3)` is the only tokenizer LanceDB 0.38 builds that can; `trigram` and `unicode61` are refused by the SDK. Its two measured costs are handled explicitly rather than left silent:

- queries under 3 characters return nothing, so they are scanned and labelled;
- it over-matches (`หลงทาง` returned the `หลงลืม` row), so candidates are verified.

**Evidence.** `app/server/test/fts-service.test.ts` drives the product path (db, startup index work, HTTP, MCP) in a child process on a fresh mktemp dataset. `app/server/test/fts-precision.test.ts` pins the shared module. Both were red on `aff9c65` before the change.

## Amendment 2026-09-26 (overnight R5)

Appended, not rewritten: §1–§8 stand except where this section says otherwise. Authority: `docs/overnight/DECISIONS.md` R5 (issues #103, #102), and the independent verifier's refutation of the first R5 implementation, which found the defect described under **Why**.

**What changed.**

- **Where audit rows are read.** `listMcpCalls` and `listConnections` (HTTP `POST /api/knowledge/:bank/listMcpCalls|listConnections`, MCP `kb_listMcpCalls|kb_listConnections`) read `mcp_calls` and `connections` from the operations root, `ARRA_DATA_DIR`. That is the store the §4 audit writer (`app/server/src/mcp/calls.ts`) and the connection fold (`app/server/src/mcp/connections.ts`) append to. They no longer read the target-19 knowledge dataset, whose copies of both tables stay empty until #34. Admission is unchanged: `audit:read`, scoped to the route bank. An unknown bank answers an empty page rather than `invalid_reference`, because the operations root keeps no workspace registry. Every predicate stays scoped to the admitted workspace.
- **What an audit row records.** This amends §4. A row's `session_name` and `peer_name` columns are recorded only when the value passes the stored-name grammar the reader enforces (`storedName`: a nonempty, well-formed Unicode string of at most 256 UTF-8 bytes). The writer checks this by calling the reader's own function, so the two cannot drift. Any other caller-supplied value is recorded as null, and the column's name is listed in `h_metadata.invalid_fields`. That key belongs to the wrapper: a caller cannot set, forge or suppress it, and it is absent when nothing was refused. The attempted value is never stored in the column. Like every other argument, it survives redacted and truncated inside `h_metadata.input`.
- **What a listing returns for a row it cannot encode.** The row is withheld from `rows` and reported as `unreadable: [{"id": …, "reason": …}]`. The reason is `unencodable` when a stored value fails the wire codec, or `duplicate_id` when more than one stored row shares the id. The key is present only when at least one row on the page was withheld, so a healthy page keeps its exact prior shape. `total` still counts stored rows. `next_after_id` advances past a withheld id exactly as it advances past a returned one. Nothing of a withheld row except its id is returned. Any other failure (a storage error, or an id the cursor cannot step past) still fails the request, as before.
- **Connection rows.** `connections.principal` is the credential id, the token id §7.2 of the SPEC names, never the principal id. `remote_ip` stays null. Capturing it is a privacy decision that R5 defers.

**Why.** Any admitted caller, with nothing more than `content:read`, could send `session_name: ""` (refused by the tool, but still audited) or a 270-byte name (accepted by the tool) over MCP. The writer stored it raw. The reader then answered `integrity_failure` for that whole workspace to every `audit:read` caller. Keyset paging could not step past the row, so every later row was hidden too. A caller with no audit authority could therefore deny the audit trail, and hide its own later calls from it.

**Evidence.** `app/server/test/fixtures/operations-root-v1/audit-poisoning.ts` drives the live routes: `POST /mcp/:bank` as a content:read-only credential, then `listMcpCalls` over HTTP and MCP. `service-level.ts` pins the writer, the reader and the fold directly. Both run in their own process, spawned by `app/server/test/operations-root-readers.test.ts`. Before the fix, 8 of 16 were red on `8857e59`: the HTTP listing answered 500 after one `session_name: ""`. After the fix, 16 of 16 are green. Two mutations each fail their own tests: storing the name raw again, and rethrowing codec rejections in the reader.

## Amendment 2026-09-26 (overnight R18 (V0 + K2 + VA fixes))

v4-overnight, v3-frame slice (Claude Opus 5.5, AI). Ruling: `docs/overnight/DECISIONS.md` R18 (D1, D6, D8, D10); design `docs/overnight/V3-PARITY.md` §2-§3. Issue #31 ("legacy adapters"). The text above is left as written; where it conflicts, this section governs.

**Why.** Nat's bar was "can v4 replace v3". Existing Claude Code configurations call v3 tool names (`oracle_search`, `oracle_learn`, ...) with v3 arguments. R18 serves those names on the same `POST /mcp/:bank`, as compositions over the same registry methods HTTP and `kb_*` call, without widening any grant.

**§1, new request class: the v3-compatible family (MCP only).**

- Off unless the operator sets `ARRA_MCP_V3_COMPAT=1` (read once in `composition.ts` as trusted configuration; any other value is off). With it off, every v3 name is unknown: 403, byte-identical to any unknown tool.
- 25 carried tools, declared as data in `mcp/legacy-v3/catalogue.ts`. The tool -> action map (`auth/service.toolAction.ts`) is DERIVED from that table, as `kb_*` is derived from the registry; the adapter never names an action. Read tools are `content:read`, write tools `content:write`; no new action.
- The five never-carried tools (`oracle_mcp_call`, `oracle_mcp_list_tools`, `oracle_trace_link`, `oracle_trace_unlink`, `oracle_profile`) have no entry, so they stay unknown (403) and nothing is spawned.
- Inbound `arra_x` resolves to `oracle_x` in the service BEFORE the action lookup (D6), so it runs under that tool's action and can never pick a cheaper grant. Aliases are never listed. `muninn_*` stays unknown.
- Scope: the route bank only. `workspace_name`, `bank`, `workspace` and v3's tenant carriers `tenantId`, `tenant_id`, `tenant`, `orgId`, `org_id` in arguments are refused with an `arra-v3-compat/1` `unsupported_argument` body before the tool runs.
- A v3 tool calls the knowledge kernels only through `kb(method, payload)`, which refuses a method outside the tool's declared `uses` list or above the tool's action, sets `workspace_name` from the route bank (refusing a payload that names another workspace), and calls the same registry entry, governed parser and peer-binding check as `kb_*` (`mcp/index.callKnowledgeMethod.ts`).
- A v3 refusal is the `arra-v3-compat/1` JSON body (`{success:false, error, compat:{version, code, tool, path?, detail}, v4_error}`), carried by the existing envelope pass-through in `runMcp` with `isError:true` and an audit row `status:"error"`. A governed v4 envelope that escapes a tool is wrapped as `kernel_error` with the envelope unchanged in `v4_error`.

**§1, `tools/list`: listing is admission AND availability.** The rule "includes only tools mapped to successful actions" still holds; a tool is additionally hidden when this deployment cannot serve it (#31: nothing proposed is advertised as live):

- `kb_*` tools are hidden when no knowledge dataset is configured (`ARRA_KNOWLEDGE_DATASET_ROOT` unset). Before this they were always listed and every call failed `unsupported_dataset` (parity defect 5).
- A v3 tool is listed only when a dataset is configured, every method in its `requires` list exists in the registry, and this build has a handler. Calling a hidden-but-granted v3 tool answers `not_yet_available`; calling a hidden `kb_*` tool behaves as before.
- Hiding never widens anything: a hidden tool is admitted or refused exactly as before.

**§2, new optional header: `X-Arra-Peer` (A7 / D8).** A connection-level assertion of which peer is speaking, for tools that record an author or act as a peer.

- Part of the v3 family: read only when `ARRA_MCP_V3_COMPAT=1`. With the flag off the header is not read at all -- no 400, no 403, no audit `peer_name` -- exactly as before this amendment. `buildApp` reads the flag once and passes it to both `createApp` (which reads the header) and the operation service (which, with the flag off, also drops any asserted peer a caller of `runMcp` passes).
- Grammar: the same bounded name grammar as the route bank (non-blank, at most 256 UTF-8 bytes), checked with the bank before any policy I/O; a malformed value is a fixed 400.
- After the four-action projection, from the SAME policy snapshot: when the admitting grant carries an R3 `peers` binding, the asserted name must be in it, else the whole request is a fixed 403 (discovery included), before the body is read and with no audit row. With no binding, any well-formed name is accepted (the trust unit stays the workspace).
- It is never derived from the bearer, the user-agent or the cwd. Tools see it as `ops.assertedPeer` (data, not authority). A tool argument `peer` may override it per call and is bound by the same list before any peer row is written.

**§3.** Unchanged: the adapter receives the facade, and the legacy-v3 modules import no store. The dead, uncalled second tool -> action map in `mcp/index.ts` is removed (parity defect 6), so the service map is the only one. `auth/service.ts` moved its type declarations to `auth/service.types.ts` and the per-request operation binder to `auth/service.bindToolOperations.ts` for the line cap; the private context constructor and the WeakMap stay in `service.ts`.

**§4, audit.** For a v3 tool the row's `tool` is the canonical name, and `h_metadata.requested_as` records the alias when one was used. `mcp_calls.peer_name` now carries the speaker the connection ASSERTED (after the binding check), or null; the principal still never populates it. This relaxes "null-or-registered peer": the asserted name may not be registered yet, because the audit row records the assertion, not a kernel reference.

- `peer_name` is the HEADER only. A per-call `peer` argument that overrides it (A7) is recorded in the row's `input` (the call's arguments) and becomes the revision's `author_peer_name`, but not `peer_name`; a reader who wants the effective author of a write reads the revision, not the audit row.

**Size (V3-PARITY §3 A9), a stated deviation.** The MCP envelope cap (256 KiB, `auth/http.ts` `MAX_BODY_BYTES`) is enforced by the transport before JSON-RPC parsing, so an over-cap v3 call is the transport's fixed `413 {"error":"payload too large"}`, not a `kernel_error limit_exceeded` tool result as V3-PARITY §3 A9 and §7 V1 #9 describe: no tool, and no tool name, is known when the body is refused. The hint A9 asked for (publish larger content with `POST /api/knowledge/:bank/publishRevision`, 1 MiB cap) is in the `____IMPORTANT` guide instead.

**Evidence.** `app/server/test/mcp-v3-frame.test.ts` (flag default, grant-driven listing, availability, dataset unset, aliases, carriers, the catalogue/service agreement with a mutation check, `kb()` bounds, the compat body through `runMcp` and its audit row, the header binding), red before the frame existed (3 pass / 25 fail). `app/server/test/mcp-v3-writes.test.ts` (V1 writes on real gated datasets) and `app/server/test/mcp-v3-acceptance.test.ts` (the v3 client session, PASS/FAIL/GAP). The flag-off header rule and the A9 guide hint were added after an independent review and seen red first (`mcp-v3-frame.test.ts`: a malformed header answered 400 and an unbound one 403 with the flag off; the guide lacked the hint).

## Amendment 2026-09-26 (overnight R18 (V5) + R7 + R14)

v4-overnight, v3-search slice (Claude Opus 5.5, AI). Rulings: `docs/overnight/DECISIONS.md` R18 (V5, D3, D6), R7 ("keyword and semantic retrieval are separate methods, not fused"), R14 (inside-word Thai). Design `docs/overnight/V3-PARITY.md` §4.4, §7 V5, §8. Issues #31 (legacy adapters) and #30 (retrieval reachable by v3 clients). The sections above are left as written; where they conflict, this section governs.

**Change 1: the family's search tools are live.** `oracle_search` (46% of real v3 calls), `oracle_ask` and `oracle_search_chain` are carried and listed. They had stayed hidden because the catalogue required `searchChunksKeyword`/`searchChunksSemantic`, the names V3-PARITY §5 designed; #30 shipped `searchKnowledgeKeyword`/`searchKnowledgeSemantic` (`search-chunk-v1.md` §13), so the §1 availability rule could never hold. The catalogue now names the shipped methods.

**Change 2: a write tool whose answer is bank content also needs `content:read`.** Admission is exact (`policy.admit.ts`: no action implies another), and HTTP and `kb_*` refuse every read to a principal holding only `content:write`. `oracle_search_chain` writes traces (V3-PARITY §2.2 gives it `content:write`) and answers with the entries it found, so a catalogue entry may now name `alsoNeeds` actions; the service derives them (`auth/service.toolAlsoNeeds.ts`, as it derives the action map) and lists or admits the tool only when the principal holds `action` and every `alsoNeeds` action on the route workspace, from the one snapshot of the projection. Otherwise it is absent from `tools/list` and calling it is the unknown tool's 403. `oracle_search_chain` declares `alsoNeeds: ["content:read"]`. Before this, `content:write` alone ran it and received entry content (found by an independent review; now tested with a write-only grant). No grant widens: every other tool is unchanged, and a principal with both actions sees no difference.

**Change 3: `kb()` and reader-only methods.** `kb()` still pins one bundle per tool call, opened for the tool's action. The #30 searches and the two chat methods exist on the reader only (`mcp/legacy-v3/readerOnlyMethods.ts`, pinned by test to the registry methods whose `call` refuses a writer bundle; the registry is unchanged). For such a method a `content:write` tool's `kb()` opens ONE reader for the call instead of reaching the writer's backstop, and only when the tool's `alsoNeeds` includes `content:read` (else an adapter wiring error, before any bundle). The §1 `uses` and action checks run first. A `content:read` tool keeps its single reader.

**Recall semantics the tools state (their descriptions say so).**

- D3: superseded and retired entries never answer recall. The kernel decides this; an entry whose head read shows a lifecycle event is also dropped, never shown. They stay readable by id.
- R7: one retrieval per call, never fused. `mode:"fts"` is keyword; `mode:"vector"` is semantic, and when the query embedder does not answer (the reader's `writer_unavailable` with an empty path) it falls back to keyword with `metadata.warning`, `vectorAvailable:false` and a `semantic_change` warning (v3's own FTS fallback); `mode:"hybrid"`, v3's default, is answered by keyword with `metadata.mode_effective:"fts"` and a `semantic_change` warning that fusion is not carried.
- Keyword meaning. v3 matched ANY word of the query (FTS5 `OR`); the v4 kernel matches one substring. The adapter runs one keyword search per word (at most 8; words under 3 code points are dropped when longer ones exist, since as substrings they match nearly everything), ranks entries holding more of the words first, then by best position, and says so (`semantic_change` on `query`, `truncated` naming dropped words). An entry's snippet is the one its first matching query word found, so it does not move when unrelated entries are written. Words include combining marks, so Thai stays whole (R14: `ลืม` finds `หลงลืม`); v3's own tokenizer cut Thai at every vowel mark. `score` is `1/(1+rank)` (`metadata.score_kind:"reciprocal_rank"`), never a kernel score value.
- Filters the kernel does not take run on each entry's head term snapshot, over the first 50 matches (`partial` says when that window was full): `type` against v3's type string (R11 `legacy_type`, else the `type` term), `project` P as P plus `_universal` plus entries with no project (v3's `project IS NULL`). `asOf` is refused (`unsupported_argument`); `model` and `retrieval:"compact-summary"` are ignored and named.
- `oracle_ask`: keyword recall over the question, then v3's extractive answer (top three sources, cited). `llm:true`, v3's default, answers extractively with a `semantic_change` warning `not_yet_available`: no knowledge-grounded model method (K8) exists yet, and `answerChat` is session-grounded.
- `oracle_search_chain`: hop 0 is semantic over the seed; later hops search by the best entry's own head text (the semantic kernel takes text, not a stored vector), skipping entries already returned; it stops on no result, only revisits, a best `1/(1+distance)` under half the previous hop's, or `maxHops`. Each hop writes one immutable trace (`mode:"chain"`, `depth:"0"`, `prev_id` = the previous hop's trace, `node_revision` hits), attributed to the speaking peer. With no query embedder it refuses with `kernel_error` before writing anything. With `idempotency_key` (A8) each hop's trace id is derived from it, so a retry over an unchanged bank replays (`already_satisfied`) and a key reused for another chain is `semantic_refusal` at `/idempotency_key`. A trace write that fails after earlier hops were written is a refusal whose detail names those traces.

**Acceptance.** `app/server/test/mcp-v3-acceptance.test.ts` on this slice: before PASS 10 / FAIL 0 / GAP 27, after PASS 15 / FAIL 0 / GAP 22 in each of 10 consecutive runs. Steps 7, 8 (`ลืม`, hybrid), 30 (`arra_search`), 31 (tenant carrier) and 36 (cross-bank isolation) went GAP to PASS. Harness corrections, each stated in its step's notes: step 13 (superseded entry absent) is also gated on `oracle_supersede`, and step 20 (distilled learning found) on `oracle_trace_distill`, since each asserts something only meaningful after that tool ran (the harness's own rule for absence steps). Step 30 compares `arra_search` with `oracle_search` called with the same arguments right after it (`compareToCanonicalCall`, recorded by the session child). A first fix compared it with step 13, but step 21 writes a node in between, and step 30 failed in 3 of 6 runs on a moved snippet. The verdict also no longer compares an alias step with itself when it names no step.

**Evidence.** `app/server/test/mcp-v3-search-wiring.test.ts` (catalogue names, availability, D3 descriptions, reader-only routing and its pin to the registry, the `alsoNeeds` rule, the stable merge snippet, chain idempotency and partial-write disclosure, the narrow embedder-down test). `app/server/test/mcp-v3-search.test.ts` (a gated child on a fresh dataset with a stub query embedder: shape, order, the multi-word OR, hybrid, R14, substring scan, D3 via `kb_supersedeNode`/`kb_retireNode`, filters, paging, refusals, vector before and after backfill, embedder-down fallback, cross-bank isolation, read-only and write-only grants, ask, chain traces and retries). `app/server/test/mcp-v3-frame.test.ts` (a write-only grant at the service) and `app/server/test/mcp-v3-verdict.test.ts` (the alias verdict). First round red 2 pass / 21 fail (`not_yet_available ... searchChunksKeyword, searchChunksSemantic`). Fix round red: unit 37 pass / 10 fail, gated 24 pass / 2 fail, with a write-only principal's `oracle_search_chain` answering 200 with entries. Then all green.

## Amendment 2026-09-26 (post-merge R3/R4/R5 + #85/#31/#75 acceptance criteria)

Behaviour change. The §4 audit now covers every transport, not only MCP.
Before this change, `POST /api/knowledge/:bank/:method` wrote no audit row. So an
HTTP call, including a `content:write` method, and the CLI's `kb <method>` leg that
forwards to it, left no trail. Rulings: #31 TODO5 ("authz/limits/redaction/audit
across transports"); R8 in `docs/overnight/DECISIONS.md` (keep #31's full
contract, do not narrow it); R5 (`mcp_calls` and `connections` are "operational
audit written on every request").

- **One sink.** `composition.ts` `composeAuditSink` is the only audit writer. It
  appends one `mcp_calls` row and folds `connections` in the operations root (R5).
  MCP reaches it through `appendAudit`, and the HTTP knowledge route through
  `buildApp` (`knowledge/transport.auditKnowledgeCall.ts`). `connections.method` is
  `bearer` and `principal` is the credential id (R19).
- **What is audited.** Every admitted call on any transport writes one row, whether
  it succeeds or fails (a body-scope refusal, a bound-peer refusal, a kernel
  error, an internal fault). What is refused before admission is audited on
  neither transport; the next amendment lists it exactly. The CLI's `kb` leg is
  audited as HTTP, and its legacy commands as MCP.
- **Parity.** An admitted HTTP call to `<method>` writes the same row as an MCP
  `kb_<method>` call: the same `tool` (`kb_<method>`), the same `status`, the same
  `input` (`{payload}`, the MCP argument shape, redacted by the same writer), the
  same `result` (the value, or the governed envelope text on error), the same
  `auth`, and a null `session_name`, as the MCP `kb_*` path records. Beyond `id`,
  `created_at` and `duration_ms`, only `internal_metadata.transport.user_agent`
  differs. `duration_ms` is timed from before admission on HTTP and from after it
  on MCP, and a whitespace-only User-Agent is recorded as null on HTTP but kept on
  MCP.
- **Redaction.** No bearer token appears in any row. `h_metadata` has exactly the keys
  `{input, result, auth}`, and `auth` has exactly
  `{principal_id, credential_id, policy_version}`. A secret-shaped argument is
  redacted the same way whichever client sent it.
- **Not yet audited.** The legacy HTTP memory routes (`/api/memories*`,
  `/api/search`, `/api/stats`, `/api/backfill`, `/api/reindex`) still write no
  row. They are not knowledge methods, and this slice does not change them. This is
  an open gap against #31 TODO5, not a rule.
- **`connections` fold key.** The key is (workspace, method, principal, label), so one
  credential used by two clients gets two rows. This matches the documented `foldId`
  in `mcp/connections.ts`. It is narrower than SPEC §7.2's `'<method>:<principal>'`
  key, and this amendment records that difference without resolving it.

Test: `app/server/test/transport-audit-parity.test.ts`, which runs on a real listening
server and spawns the real CLI process. Red before the change: 8 rows missing
(`kb_getContext` x2, `kb_listNodes` x4, `kb_listMcpCalls`, `kb_listConnections`),
because every HTTP and CLI-`kb` row was absent.

## Amendment 2026-09-26 (post-merge #31 TODO 'success/failure audit consistently across all transports' + R5/R19)

Behaviour change, round 3 (2026-09-27). The amendment above said a body-scope
refusal writes no row on either transport, which was false. An independent
verifier found the gap: MCP checked the payload's `workspace_name` AFTER
admission (`mcp/index.ts`, inside the dispatch `runMcp` audits), so it wrote an
error row. HTTP checked it BEFORE admission (`knowledge/transport.ts`) and wrote
nothing. A cross-workspace attempt (an alpha route, a beta body) therefore left a
trail on MCP and none on HTTP. Rulings: #31's TODO "success/failure audit
consistently across all transports"; R5 in `docs/overnight/DECISIONS.md`
(`mcp_calls` and `connections` are "operational audit written on every
request"); R19 (`connections.method` is `bearer`, `principal` the credential
id).

- **Direction.** Both transports now audit the refusal. The other option,
  dropping MCP's row, would erase the only trail of an authenticated
  cross-workspace attempt.
- **HTTP order.** The route still peeks the body scope before admission, but it
  now admits before it refuses the mismatch. If admission fails, the response is
  the same 400 `{"error":"bad request"}` as before and no row is written. If
  admission succeeds, the response is also the same 400, and one `error` row is
  written. No HTTP status or body changed.
- **The row.** Both transports raise one refusal
  (`knowledge/transport.bodyScopeRefusal.ts`), so both rows have
  `tool` `kb_<method>`, `status` `error`, `input` `{payload}` (the body that
  named the other workspace, redacted by the same writer), `result`
  `payload workspace_name must match the connected bank`, the admitted principal
  and credential in `auth`, and `workspace_name` set to the route workspace, never
  the workspace the body named. The two rows differ only in `id`, `created_at` and
  `duration_ms`. A body with no `workspace_name` at its scope path is refused and
  audited the same way.
- **Audited, after admission, on both transports:** every call that runs, whether it
  succeeds or fails; a body-scope refusal; a bound-peer refusal (#87 / R3); and, on
  MCP, a `tools/call` whose `arguments` is not an object.
- **Not audited, on either transport:** a request with no `Authorization` header or
  with a token no credential matches (401); a valid credential with no grant for the
  route workspace and action (403); an unreadable policy (503); and, on HTTP, a bad
  route, an unknown method, a bad body encoding, an oversized body, or a body the
  governed parser refuses. On MCP, the matching refusals are an unreadable
  envelope, a method other than `tools/call`, and an unknown or unpermitted tool.
  Unauthenticated requests leave no row and no `connections` fold. The legacy HTTP
  memory routes are still unaudited (see above).
- **Response difference, unchanged.** On HTTP an unauthenticated body-scope
  mismatch is still a 400 (the body is judged first). On MCP it is a 401 (the
  credential is judged first).

Test: `app/server/test/transport-audit-refusals.test.ts`, which runs on a real
listening server (`fixtures/transport-v1/live-server/child.ts`). It checks that a
body-scope refusal and a bound-peer refusal each write two equal rows (HTTP and
MCP), and that no header, a bogus token and a foreign credential, with and without
a scope mismatch, write no row and no fold on either transport. Before the change
it failed with one `kb_listNodes` row missing, the HTTP body-scope refusal. Mutants,
each killed by that test: dropping the HTTP scope audit, dropping the HTTP bound-peer
audit, auditing a different result text on HTTP, returning the auth status for an
unauthenticated mismatch, and auditing unadmitted HTTP requests.

## Amendment 2026-09-26 (post-merge #31 TODO 'success/failure audit consistently across all transports' + R5/R19)

Behaviour change, legacy-audit slice (2026-09-27). This closes the gap the two
amendments above list as "Not yet audited", corrects one sentence in the round-3
amendment, and records two row differences it left out. Rulings: #31's TODO
"success/failure audit consistently across all transports"; R5 in
`docs/overnight/DECISIONS.md` (`mcp_calls` and `connections` are "operational
audit written on every request"); R19 (`connections.method` is `bearer`,
`principal` the credential id).

- **Auth model, checked first.** Every legacy HTTP route is protected by design:
  each one admits a bearer credential before it reads a payload (`app.ts`,
  `auth/service.ts`). None is unauthenticated, so none is left unaudited for that
  reason. There is no `/api/stats` route; the workspace stats route is
  `GET /api/health?bank=`, and there is no `/api/memories/:id` route.
- **Legacy routes, audited as their MCP twin.** An admitted call writes one row
  through the same `appendAudit` and `composeAuditSink`, whether it succeeds or
  fails:

  | HTTP route | action | row `tool` (the MCP twin) | row `input` |
  |---|---|---|---|
  | `GET /api/memories?bank=&limit=` | content:read | `list_memories` | `{limit}` when sent |
  | `GET /api/search?bank=&q=&mode=&limit=` | content:read | `recall` | `{query, mode, limit}`, each only when sent |
  | `POST /api/memories` | content:write | `remember` | the body without `workspace_name` |
  | `GET /api/health?bank=` | diagnostics:read | `bank_info` | `{}` |

  The input is in the twin's argument shape: a digit-only query value is recorded
  as a number, anything else as the string sent, and the body's scope carrier is
  dropped because MCP refuses one in arguments. `session_name` is read from that
  input exactly as `runMcp` reads `args.session_name`. `peer_name` and
  `requested_as` are null: the legacy routes do not read `X-Arra-Peer` and have
  no aliases. The user agent, redaction, `auth` and `workspace_name` (the admitted
  route workspace) are recorded as on MCP. `duration_ms` is timed from after
  admission, as on MCP.
- **Result.** Each row records what its own caller received. For `list_memories`
  and `recall` the two transports answer the same value, so the rows are equal
  except `id`, `created_at` and `duration_ms`. For `remember` HTTP answers
  `{id, embedded}` and MCP adds `sync_state` and `note`. For `bank_info` HTTP
  answers `{db, embedder:{ok, dims}}` and MCP
  `{bank, rows, embedded, unembedded, embedder}`. For those two the `result`
  differs and every other column is equal.
- **Failures.** A non-scope parameter the route refuses after admission is audited
  with the text MCP raises for the same argument, and the HTTP response is still
  the fixed 400: `query is required`, `query must be a non-blank string`,
  `limit must be a number`, `limit must be a safe integer between 1 and 1000`,
  `mode must be 'text' or 'vector'`, `content is required`, `name is required`,
  and `<field> must be a non-blank string`. The checks run in MCP's order. One
  validation difference stays: `name` is required on `POST /api/memories` and
  optional on MCP `remember`. A bound-author refusal (#87 / R3) is audited as
  `forbidden` on both.
- **Not audited.** `POST /api/backfill` and `POST /api/reindex` admit a
  global action. They have no MCP twin, because MCP is per workspace and has no
  maintenance tool. There is also no workspace to file a row under, because
  `mcp_calls.workspace_name` is non-null and every reader is scoped to an
  admitted workspace. Filing the row under an invented workspace would fabricate
  attribution, and §4 forbids a physical schema change here. So an admitted
  maintenance call writes no row and no `connections` fold. A request refused
  before admission writes no row, as on the knowledge routes: no or bad token
  (401), no grant (403), or an unreadable policy (503). The same applies to a
  scope that is malformed, missing, conflicting or repeated (400 before policy),
  and to a POST body refused by encoding, size or the strict parser before
  admission.
- **Correction: a knowledge body that is not an object.** The round-3 sentence "A
  body with no `workspace_name` at its scope path is refused and audited the
  same way" holds for objects only. For a body that is an array or a scalar
  (`[]`), MCP always audited `payload must be an object`, while HTTP audited the
  body-scope text. Both now raise one refusal
  (`knowledge/transport.payloadRefusal.ts`), so both rows record
  `payload must be an object` with input `{payload: []}`. The HTTP response is
  unchanged (400 `{"error":"bad request"}`). The round-3 amendment's "unreadable
  policy (503)" is also imprecise: with a scope mismatch, HTTP answers 400 for
  any unadmitted request, the policy case included, and writes no row.
- **Two MCP-only row values on `kb_*`, documented rather than aligned.** They are
  outside the list of differences the amendments above give:
  - Under `ARRA_MCP_V3_COMPAT=1`, an MCP row's `peer_name` is the speaker the
    connection asserted in `X-Arra-Peer`, after the R3 binding check. The HTTP
    knowledge route never reads that header (it belongs to the v3 MCP family,
    R18 A7/D8), so its `peer_name` is always null. With the flag off, both are
    null.
  - An MCP row's `session_name` is a top-level `session_name` argument sent next
    to `payload` (`{payload, session_name}`), when it is a string. An HTTP
    knowledge request has no top-level arguments, because the body is the
    payload. Its `session_name` is therefore always null, and a `session_name`
    inside the payload is not lifted on either transport.

  Aligning either one would mean inventing an HTTP carrier that no client sends.
- **Shared error text.** The governed-envelope error text is one function
  (`auth/service.auditErrorText.ts`), used by `runMcp`, the legacy routes and
  `knowledge/transport.auditKnowledgeCall.ts`, so it cannot drift.

Test: `app/server/test/transport-audit-legacy.test.ts`, on a real listening server
(`fixtures/transport-v1/live-server/child.ts`, extended with a `legacy` step and
the `diag`/`maint` credentials). Before the change it failed because every legacy
HTTP row was missing: 7 rows (`remember`, `list_memories`, `recall` and
`bank_info` ok; `recall`, `list_memories` and `remember` error). Seven mutants, each
killed by that test: no audit row on failure, auditing the raw service value
instead of the answer, recording a defaulted `mode` in the input, a generic error
text, the body-scope text for `[]` on HTTP, dropping the `list_memories` audit, and
auditing an unadmitted request.
