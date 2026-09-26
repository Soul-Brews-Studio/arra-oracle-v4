# Authorization v1 — review draft

Status: **APPROVED FOR THE ISOLATED SECTION 7 PURE-POLICY SLICE ONLY**. Independent review approved normative draft `4d65ed6e2739ac9622ec6c118a8e36e3baafeb79c5ebcf16d8b45c035b36ce85`; this status update changes no normative behavior. Full transport/service integration remains unapproved. Owner: v4-codex (AI). Baseline `5dca2ae`; #23 and #24 closed, #25 open. This defines the next security gate; no credential provisioning, runtime restart, deployment or live data change is authorized.

## 1. Selected bounded identity source

Use operator-managed opaque bearer credentials and explicit workspace grants. No OAuth server, login database, new LanceDB tables or new dependencies are required for this version. This does not promise OAuth discovery or compatibility with clients requiring interactive OAuth; those clients require a separately reviewed adapter.

The operator provides a local policy file outside the repository and dataset, selected by explicit server configuration. Policy contains credential IDs, principal IDs, SHA-256 credential digests (never raw secrets), activation/expiry times, revocation flags and workspace grants. Raw credentials must be cryptographically random with at least 256 bits of entropy; hashing is appropriate for random credentials, not user passwords. Production issuance is outside this slice; tests use isolated synthetic credentials.

Each protected request reads and validates the complete policy before authenticating. Missing/unreadable/malformed policy fails closed; no last-known-good fallback that could conceal revocation. Atomic file replacement is the operator update mechanism. A request uses one immutable validated snapshot and one server clock value; a request admitted before revocation may finish. Subsequent requests observe replacement. No refresh API or policy mutation endpoint is added.

Policy schema and exact error precedence must be frozen after the entrypoint inventory and critic review, before code dispatch. Duplicate credential IDs/digests, unknown actions, invalid times and conflicting grants reject the entire policy. The file and containing directory need operator-controlled permissions; filesystem writers are in the trusted computing base.

## 2. Identity and permissions

Authenticated principal is a credential-derived operational identity, not a registered peer, author, observer, subject, session handle or User-Agent. None of those fields grants permissions. A credential is scoped by explicit grants; workspace names are exact strings, not prefix patterns. No wildcard workspace grant in v1.

Proposed closed workspace actions:

- `content:read`: content/session/trace/taxonomy/evidence/search/context reads within that workspace.
- `content:write`: corresponding mutations, subject to each service's invariants; does not imply read or audit permission.
- `audit:read`: call logs and aggregates.
- `diagnostics:read`: workspace statistics and non-secret operational diagnostics.

Global maintenance has exactly two separate grants: `maintenance:backfill` and `maintenance:reindex`. They authorize only the named current operations, never migration or any future operation. Workspace write permission cannot authorize a dataset-wide operation. Pure liveness may be public, but must reveal no paths, bank names/counts, credentials, model addresses or operational errors and must invoke neither storage nor models. Detailed health/status is protected.

Workspace configuration and taxonomy administration need explicit action review before those endpoints ship; ordinary content write must not silently become policy administration. Credential policy remains out-of-band and has no product API.

## 3. One service gate, not transport discipline

All network transports pass credentials and requested scope to one authentication/authorization boundary. The service establishes an immutable request context; clients cannot submit a principal or an already-authorized context. The same gate precedes HTTP, MCP and CLI-dispatched operations and future service methods. Stores retain #24 scope checks as defense in depth, not as identity validation.

Authentication and authorization happen before data lookup, embedding calls, mutation, bank statistics or user-visible audit lookup. Tool discovery/initialization also requires valid credentials and a permitted route workspace; the exact discovery permission rule is a review item. Unknown operation names must not fall through to an unguarded dispatch.

Cross-reference validation checks the authorized workspace and referenced row's scope, not only globally unique IDs. Missing and inaccessible references must not expose existence. External evidence locators convey no fetch authority: no arbitrary network dereference, ambient credentials or inferred access. Future fetch adapters need separate permission and SSRF review.

Audit append is a trusted internal consequence of an admitted operation, not a caller-grant action or public append endpoint. Record authenticated principal and credential IDs separately from peer attribution; never overwrite `peer_name` with principal ID. Authentication failures must not append into an attacker-selected tenant log. Any operational rejection telemetry must be bounded and secret-free, outside tenant-visible data. Existing audit persistence failure semantics require explicit integration tests rather than a claim of durable audit guarantees.

Resolve the requested workspace exactly once: MCP uses route scope; HTTP content writes use their validated body workspace. If an endpoint accepts another scope carrier, conflicting values reject rather than silently preferring one. Authorize that resolved scope before execution. `insert` must no longer invent a default workspace. Public static assets may remain public if they contain no credential or tenant data; all data-fetch/mutation paths still require admission.

Global maintenance must not remain callable through unguarded public routes. Startup maintenance is a distinct trusted operator path; it is not evidence that external callers have permission.

## 4. Transport and deployment boundaries

Accept credentials only through a single Authorization Bearer header, never query parameters, URL paths, request metadata, peer fields or body credentials. Malformed, duplicate/ambiguous, missing, unknown, expired, not-yet-valid and revoked credentials fail closed. Compare digests using a timing-safe primitive after fixed-length validation. Do not log credentials, policy contents, Authorization headers or raw authentication exceptions.

Missing/invalid credentials return generic HTTP 401; authenticated but insufficient grants return generic 403. Policy-unavailable returns a non-secret 503. MCP HTTP authentication failures occur before JSON-RPC dispatch and tenant call logging. Operation errors retain their existing contract after successful admission. No token value is echoed in a challenge or error. Exact headers and error envelopes remain to be frozen with transport tests.

Default startup is secured: absent policy must not silently enable anonymous mode. Local development also uses explicit synthetic credentials/grants; no anonymous fallback. Keep loopback binding as the default. Remote deployment requires a separately reviewed TLS/proxy boundary; forwarded headers do not establish identity. CLI reads a credential from explicit environment/config, never prints it; browser credentials remain in memory only and are not embedded in static assets or persisted in browser storage. Browser same-origin and request-origin policy requires review before enabling authenticated UI mutations.

## 5. Acceptance and staging

1. First implement and test pure policy validation/admission, isolated from active routes; no runtime auth claim follows.
2. Integrate one service context and all inventoried entrypoints together, including maintenance and detailed diagnostics. Current direct-handler tests must prove they cannot bypass admission.
3. Negative tests: missing/bad/expired/revoked credentials; unreadable or malformed policy; exact-time boundaries; replacement revocation on next request; absent grants; unknown workspace; bank A credentials against B objects, aggregates, logs and search; attribution changes do not widen access.
4. Assert rejected requests perform no model/storage/write side effects; verify credentials absent from persisted audit, errors and console output. Denied access must not reveal counts or object existence.
5. CLI and browser tests cover credential transmission, no credential output/persistence, and fail-closed missing credentials. No live secret is used.
6. Existing contract fixtures, Python tests, Bun tests, typecheck/build and targeted static checks remain green. Authentication integration must not activate target19 or mutate live data.
7. #25 closes only after shared-boundary integration and tests, not after this document or a pure token checker. Future #26–#34 services must use the same gate and carry their own cross-reference tests.

## 6. Review questions to resolve before implementation

- Exact closed policy shape, identifier limits, expiry representation, action set and deterministic error ordering.
- Minimal permission for MCP initialization/discovery and protected detailed status without leaking cross-bank diagnostics.
- Browser Origin/Host policy and CLI environment/config precedence, without inventing an OAuth subsystem.
- How service context construction is kept internal and how direct exported handlers are tested against bypass.
- Separation of operator startup maintenance from request-authorized maintenance and future taxonomy/config administration.

No existing auth-related SPEC promise becomes verified by this draft. Runtime remains the unauthenticated loopback spike until independently accepted integration and separately authorized activation.

## 7. Approved isolated pure-policy slice

This section freezes the reviewed first implementation surface. Implementation requires the explicit bounded dispatch and file hash; sections 1–6 describe the broader direction, not authorization to integrate it.

### Closed policy document

```json
{
  "version": "arra-auth/v1",
  "principals": [{
    "id": "operator-a",
    "disabled": false,
    "workspaces": [{
      "name": "alpha",
      "actions": ["content:read", "content:write", "audit:read", "diagnostics:read"]
    }],
    "global_actions": []
  }],
  "credentials": [{
    "id": "credential-a",
    "principal_id": "operator-a",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "not_before": "2026-09-20T00:00:00.000Z",
    "expires_at": "2026-09-21T00:00:00.000Z",
    "revoked": false
  }]
}
```

The displayed digest is a shape illustration, NOT a credential to install. Every listed key is required; extras reject at every level. Arrays may be empty (valid deny-all policy). Limits: original UTF-8 document <=256 KiB, depth <=16, <=256 principals, <=1024 credentials, <=256 workspace entries per principal. IDs match `[A-Za-z0-9_-]{1,64}`; workspace names are exact valid-Unicode nonblank strings <=256 UTF-8 bytes, no trimming/case folding. Actions must be unique members of the closed sets in section2. Global set contains only `maintenance:backfill` and `maintenance:reindex`; neither implies the other. Migration/configuration/taxonomy administration has no v1 global action and requires separate reviewed versioning. Principal IDs, credential IDs and credential digests are unique. Each principal has unique workspace names; each credential references a declared principal. Timestamps are canonical UTC millisecond strings within Gregorian 0001–9999; `not_before < expires_at`. Reject duplicate decoded JSON keys, invalid Unicode, invalid JSON and all non-boolean flags.

Raw bearer secret syntax is exactly 64 lowercase hex characters, generated from 32 random bytes; digest is SHA-256 of those ASCII characters, without prefix/newline. No plaintext policy secret field exists. Credential ID is not part of the bearer text and no substring lookup is permitted. Syntactically invalid presented credentials receive the same public failure as unknown credentials.

### Pure interface and deterministic decisions

Proposed new module `src/auth/policy.ts` exports only:

- `parsePolicy(raw: Uint8Array): Policy`: check the original byte length before a fatal UTF-8 decode, then validate strict raw JSON and return an opaque parser-produced policy snapshot. No file reads or environment access. Malformed policy yields `policy_invalid`; diagnostics must never include raw input, digests or tokens.
- `admit(policy: Policy, input): Admission`: input has `authorization: string|null`, `now_ms: number`, and exactly one target: workspace `{workspace,action}` or global `{action:"maintenance:backfill"|"maintenance:reindex"}`. No clock reads; caller supplies one safe integer epoch-millisecond value within [-62135596800000, 253402300799999], the canonical Gregorian year 0001–9999 range. Success returns principal ID, credential ID, target scope/action and policy version, never secret/digest or peer identity.

Policy validation order is: raw input type/256-KiB byte cap -> fatal UTF-8 decode -> strict JSON/duplicate decoded keys/depth -> root closed shape -> principals in array order -> credentials in array order -> uniqueness/references and cross-field times. Root field order is version, principals, credentials. Principal field order is id, disabled, workspaces, global_actions; workspace field order is name, actions; credential field order is id, principal_id, sha256, not_before, expires_at, revoked. For each closed object, check missing required fields in listed order, then unknown keys in UTF-16 lexical order, before field values. Collection limits precede element validation. After all shapes/values pass, check principal IDs, then per-principal workspace uniqueness/action duplicates, then credential IDs, credential digests, credential principal references, then each credential's not_before < expires_at, each in array order. Global-action duplicates are checked with the principal action duplicates. Public policy failures are generic `policy_invalid`, never input values or JSON excerpts.

The runtime snapshot is a frozen opaque handle registered in a module-private WeakMap, whose backing records/arrays are recursively frozen and never exposed; no public mutable Map/Set. `admit` rejects any handle not created by this module's parser (including JSON copies, spread clones and prototype lookalikes) as `invalid_request`. This is an in-process construction boundary, not protection against arbitrary malicious code executing in the same process. Admission output is deeply frozen and carries no policy data.

The module exports exactly two runtime functions (`parsePolicy`, `admit`); TS-only type exports are allowed. All expected failures throw Error instances with one readonly `code` from `policy_invalid|invalid_request|unauthenticated|forbidden` and a fixed generic message for that code; no cause, pointer containing caller text, token, digest, policy excerpt or echoed field value. Reuse existing strict JSON/Unicode/time helpers internally without leaking their diagnostic values; do not change their existing contracts. No transport status/JSON envelope is introduced in this pure module.

Admission input is a closed ordinary object with exactly authorization, now_ms, target. Target is exactly `{kind:"workspace",workspace:string,action:WorkspaceAction}` or `{kind:"global",action:GlobalAction}`. Workspace strings use the same policy grammar. Invalid action/kind/extra/missing keys or untrusted snapshot is `invalid_request`; authorization null or any non-string value is `unauthenticated` after trusted shape/time/target validation. Success contains exactly `{policy_version:"arra-auth/v1",principal_id,credential_id,target}` with a copied/frozen target. No getters or exotic object transport is supported; the service must create ordinary own-data-property inputs rather than passing raw request objects.

`Policy` construction and `Admission` transport into the eventual service must not treat client JSON or structural TS types as proof of authorization. First slice remains isolated; integration owns unforgeable internal context construction and all entrypoint wiring. Exported pure helpers are not themselves a secured service.

Deterministic admission order: validate trusted invocation shape/time -> validate presented header grammar -> hash and compare presented secret with policy credential digests -> require exactly one matching enabled credential and enabled principal -> require `not_before <= now < expires_at` -> test exact grant. Missing or malformed header, unknown/revoked credential, disabled principal, and time-window failure all produce the same `unauthenticated` code; only an authenticated principal missing the exact grant produces `forbidden`. Invalid trusted invocation yields `invalid_request`; parsing/configuration errors yield `policy_invalid`. No permission union across credentials, workspace names or principals.

Header value accepts case-insensitive ASCII `Bearer`, exactly one ASCII space, then the 64-character lowercase token; no leading/trailing whitespace, commas, second scheme or multiple credentials. Repeated Authorization headers must be rejected by transport before this function; passing a flattened value does not prove the server detected duplicates. Scan all credential digests using a timing-safe fixed-length comparison; avoid claiming constant-time behavior for the entire request or policy lookup.

### First-slice evidence

Additionally test malformed UTF-8 bytes, exact original-byte limit including whitespace/escapes, forged/cloned snapshot rejection, unsuccessful mutation of opaque snapshot/admission, out-of-range or unsafe-integer clocks, and rejection of unknown/future global actions.

Use literal synthetic credential inputs with independently computed digest expectations. Cover every policy closed-shape and duplicate rule; every limit at boundary and boundary+1; raw escape/whitespace size; immutable nested collections; bad flags and times; credential references; missing/invalid/unknown/expired/not-yet-valid/revoked/disabled cases; exact not-before and expiry edges; principal/grant separation; case-sensitive workspace mismatch; empty deny-all grants; content write not implying read/audit/global access; and two principals across two workspaces. No test may use a real credential or mutate operator policy.

The first slice explicitly excludes file loader, live revocation reload, route wiring, MCP discovery, browser Origin/Host checks, CLI/browser plumbing, audit persistence, and external deployment. Those are mandatory later #25 integration work, not waived acceptance items. No #25 closure from the pure module.

## Amendment 2026-09-26 (overnight R3)

Appended, not rewritten: §1–§7 stand except where this section says otherwise.
Authority: `docs/overnight/DECISIONS.md` R3 (issue #87). This section adds an optional
peer binding to the `arra-auth/v1` policy document. The document version does not change,
because every existing policy stays valid and means exactly what it meant before.

**Grammar change to §7.** A workspace grant is `{name, actions[, peers]}`:

- `peers` is optional, and the only optional key anywhere in the document.
- When present it is an array of at most 256 entries. Each entry is a nonempty string of
  at most 256 UTF-8 bytes, with no trim and no case folding, which is the context kernel's
  peer-name grammar. Entries are unique within the grant.
- Anything else is `policy_invalid`. Duplicate entries are checked with the other
  per-principal duplicates.
- Field order is name, actions, peers. Extras still reject at every level. An empty array
  is valid and binds the grant to no peer at all.

```json
{"name": "alpha", "actions": ["content:read", "content:write"], "peers": ["peer-a"]}
```

**Meaning.**

- The binding is anti-spoofing only. It grants no action and no visibility.
- When a grant carries `peers`, every peer name the caller ASSERTS in a request admitted
  by that grant must be in the list. This covers every surface such a grant admits
  today: the knowledge methods (`/api/knowledge`, MCP `kb_*`) and the legacy memories
  write (MCP `remember`, HTTP `POST /api/memories`). The table below lists every field.
- The refusal happens after admission and before any dataset writer is opened, any
  kernel runs, or any row is stored. Each surface refuses in its own existing error
  shape:
  - knowledge methods: HTTP 403 and MCP `isError`, both carrying the
    `arra-publication-error/v1` envelope with code `forbidden`, whose path points at the
    offending field;
  - `POST /api/memories`: HTTP 403 with the fixed body `{"error":"forbidden"}` that every
    memories-route 403 already uses (`auth/http.ts` `ERROR_BODIES`);
  - `remember`: an MCP `isError` tool result whose text is `forbidden`. It is audited
    like every other admitted tool failure.
- When `peers` is absent, nothing is checked and the trust unit remains the workspace, as
  before.
- This does not contradict §2 ("principal is not a peer"). A principal is still never
  automatically any peer; an operator binds one explicitly, per workspace grant.

**Which fields are asserted peers.**

| Role | Surface | Field |
|---|---|---|
| requester | `getMessage`, `listMessages` | `/requester_peer_name` |
| requester | `getContext`, `answerChat` | `/peer_name` |
| reader | `getReadCursor`, `advanceReadCursor` | `/peer_name` |
| joining peer | `joinSession` | `/peer_name` |
| author | `appendMessages` | `/items/i/message/peer_name` |
| author, observer | `publishRevision` | `/content/author_peer_name`, `/content/observer_peer_name` |
| author | legacy `remember`, `POST /api/memories` | `peer_name` |

Lookup targets (`getPeer.peer_name`, `registerPeer.name`), `list_memories`' `peer_name`
filter, and the subject of a revision or memory (`subject_peer_name`) are not bound.
Naming a peer, or writing ABOUT one, is not acting as it.

Where each surface is declared:

- The knowledge rows are data in `app/server/src/knowledge/registry.peerFields.ts`. That
  table is exhaustive over the registry, and `[]` there is a reviewed "asserts no peer".
- A knowledge method the table does not classify is refused outright under a binding,
  at the request root (path `""`). It is never let through unchecked.
- `transport-peer-fields.test.ts` fails while any registered method is unclassified.
  So a future method with an acting-peer field is classified when it is exposed. Examples
  are #28's `created_by_peer_name` and `traces.peer_name` (DECISIONS.md R7), and a
  lifecycle `peer_name`.
- The legacy row is checked in `app/server/src/auth/service.ts`, in both insert paths,
  through `service.isBoundAuthor.ts`.

**Pure-module surface (§7) is unchanged.**

- `src/auth/policy.ts` still exports exactly two runtime functions, `parsePolicy` and
  `admit`.
- An Admission is still exactly `{policy_version, principal_id, credential_id, target}`,
  with no policy data and no peer identity.
- The binding is read by a sibling pure helper, `peerBinding(policy, admission)` in
  `src/auth/policy.peerBinding.ts`, which the barrel does not export. It returns the
  grant's frozen list, or null when the grant carries none.
- `peerBinding` answers `invalid_request` for:
  - a snapshot this module did not parse;
  - a global admission;
  - an admission naming a principal or grant the snapshot does not hold.

**How it reaches the services.** The transport builds a
`RequestAuthority {operator, peers}` from the same snapshot that admitted the request:

- `peers` comes from `peerBinding`.
- `operator` means the principal also holds `audit:read` on the workspace. HTTP checks it
  with a second `admit` on the same snapshot and clock value. MCP takes it from the
  four-action projection.

The transport enforces the binding itself, and passes the authority to the message reads,
which recheck their own requester (context-ingestion-v1.md, amendment of this date). The
MCP request context is unchanged: the authority travels as data on the per-request
`ToolOperations`, never as a capability.

**Evidence.**

- `app/server/test/auth-peer-binding.test.ts`: grammar, limits, lookup, frozen surface.
- `app/server/test/transport-read-boundary.test.ts`: HTTP and MCP refusals and the unbound
  control.
- `app/server/test/auth-legacy-peer-binding.test.ts`: the legacy author over the service,
  HTTP and MCP. A refused write stores nothing; the subject stays free; the unbound
  control is unchanged.
- `app/server/test/transport-peer-fields.test.ts`: the table equals the registry, and an
  unclassified method fails closed.

All four were seen red before the change. The legacy and classification rows were added
in a fix round after verification showed a bound principal could still store
`peer_name: "outsider"` through `remember` and `POST /api/memories`.
