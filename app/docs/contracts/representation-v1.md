# Peer representation v1 (`getRepresentation`)

Status: written with the implementation (Nat 2026-09-28 NAT-DECISIONS D3b, recorded in
`docs/overnight/DECISIONS.md`; AC-MATRIX slice 11). Source: `app/server/src/publication/`
`service.getRepresentation.ts`, `service.selectConclusions.ts`, `chat.parseGetRepresentation.ts`;
registry entry `getRepresentation` in `app/server/src/knowledge/registry.ts`. Tests:
`app/server/test/context-peer-representation.test.ts`, `app/cli.test.ts` ("peer context").

DESIGN.md §12 separates four operations: SEARCH, CONTEXT, REPRESENTATION, CHAT. This
contract is REPRESENTATION: `observer + subject -> selected knowledge view`.

## 1. No new table

A representation is computed on every read from rows that already exist: `nodes`,
`node_revisions` (head revision, `observer_peer_name`, `subject_peer_name`,
`term_snapshot_json`, `link_snapshot_json`), `supersede_log`, `peers` and `session_peers`.
There is no `peer_cards` table, no cache and no stored profile. A `conclusion` is the
reserved `type` term of R10, not a table.

## 2. Request grammar

```
getRepresentation {workspace_name:S(<=256B), observer_peer_name:S(<=256B),
                   subject_peer_name:S(<=256B), max_items:1..50,
                   requester_peer_name?:S(<=256B)|null}
```

Closed object. `observer_peer_name` and `subject_peer_name` are both REQUIRED: one call is
one directed `observer -> subject` view. There is no "any observer" form, because that would
merge observers into a global profile, which §12 forbids. `requester_peer_name` is optional
on the same terms as `listMessages` (#87 / R3).

## 3. Authorization

- Admission: `content:read` on the workspace (registry), exactly as `getContext`.
- Read boundary, before any dataset read (`requireMessageReadAuthority`):
  - no requester: only the operator view (the grant also holds `audit:read`), else
    `forbidden` at `/requester_peer_name`;
  - a named requester must sit inside the grant's `peers` binding, else `forbidden`.
- `PEER_FIELDS.getRepresentation = [["requester_peer_name"]]`. Observer and subject are
  lookup targets, not acting peers, so a peer-bound grant may ask about any observer and
  subject. That is the rule for `publishRevision.subject_peer_name` too.
- The requester, observer and subject must each be a registered peer of the workspace,
  else `invalid_reference` at that field's path. Existence only: naming a perspective grants
  nothing and requires no membership.

## 4. Selection (shared with `getContext`)

`selectConclusions` examines at most 1000 nodes (`MAX_SCANNED_CONCLUSION_NODES`), most
recently updated first (`updated_at desc, id asc`). A node is selected when all of these hold:

1. its accepted head is `nodes.current_revision_id` (never a re-derived "latest");
2. it has no terminal `supersede_log` event (not superseded, not retired);
3. the head `is_active` and `asOf` is inside `[valid_from, valid_to)`, decided by the
   centralized #29 predicates (`eligibilityReasonsOf`); `asOf` is the registry's `Date.now()`;
4. the head's `type` term snapshot is `conclusion`;
5. `observer_peer_name` and `subject_peer_name` equal the request's;
6. the head's `session_name` is null, or the caller may read that session. A named requester
   must be a CURRENT member of it. The operator view may read every session.

A head whose type term is `summary` is the stored summary (`summary`), under the same rules.
No reserved `summary` term is seeded, so in practice `summary` is `null` unless a workspace
has added one. It is never generated on a read.

## 5. Result

```
{workspace_name, observer_peer_name, subject_peer_name,
 conclusions: [{node_id, revision_id, revision_no, title, text, author_peer_name,
                observer_peer_name, subject_peer_name, session_name, created_at,
                sources: [{relation, target_kind, target, capture_status}],
                sources_incomplete}],
 summary: <conclusion shape> | null,
 coverage: "full" | "partial",
 budget: {max_items, max_wire_bytes, used_wire_bytes, tokenizer: null,
          token_count_kind: "estimate", estimate_heuristic: "ceil(utf8_bytes/4)",
          estimated_tokens, truncated},
 freshness: {assembled_at, source_watermarks: {messages, session_peers, nodes,
             node_revisions, supersede_log}, index_watermark: "unknown"}}
```

- `sources` comes from the revision's own `link_snapshot_json`. A `message` or `session`
  handle into a session the caller may not read is dropped. `sources_incomplete` becomes
  true, and nothing else says what was dropped.
- `coverage` is `"partial"` when a conclusion or source was withheld, the scan bound was
  reached, or `max_items` or the wire-byte budget (`MAX_CONTEXT_WIRE_BYTES`, 65536) stopped
  an eligible conclusion. It is a coarse flag. There are no counts and no ids of withheld
  material (DESIGN.md §12).
- `budget`: this server has no tokenizer. `tokenizer` is `null` and the token figure is always
  an estimate with its heuristic named. The enforced limits are the item count and the wire
  bytes.
- `freshness`: `assembled_at` is the request time. The watermarks are the table versions the
  reader observed after assembly. Assembly is not an atomic snapshot. This read does not
  touch the search index, so its watermark is `"unknown"`, not zero.

## 6. Model-free and write-free

The method uses only `refresh`, `orderedProjection`, `query` and `version` on the reader.
It holds no model and no writer. The test compares every table's version and row count
before and after context and representation reads, with a chat model that throws if it is
called. Nothing moves, and the model is never called.

## 7. Transports

- HTTP: `POST /api/knowledge/:bank/getRepresentation`, the registry route every knowledge
  method uses. DESIGN.md §12's endpoint list names `GET .../representations`. No knowledge
  method has a GET route, so this contract uses the registry recipe, not a new route shape.
- MCP: `kb_getRepresentation` (generated from the registry).
- CLI: `kb getRepresentation --bank B --json ...`, and the alias
  `peer context --bank B --observer O --about S [--requester R] [--max-items N]`.

The registry now has 58 methods.

## 8. Errors

| Condition | Code | Path |
|---|---|---|
| unknown or extra key, bad type, `max_items` out of range | governed `arra-error/v1` | the key |
| no requester and not operator; requester outside the peer binding | `forbidden` | `/requester_peer_name` |
| unknown workspace | the existing `requireWorkspace` code | |
| requester, observer or subject not a peer of the workspace | `invalid_reference` | that field |
